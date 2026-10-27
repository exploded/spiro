/*
Spiro - a browser-based Spirograph drawing app.

Copyright 2026 James McHugh

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
*/
package main

import (
	"context"
	"html/template"
	"log/slog"
	"net"
	"net/http"
	"net/netip"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/exploded/monitor/pkg/logship"
)

var templates *template.Template

func init() {
	var err error
	templates, err = template.ParseGlob("templates/*.html")
	if err != nil {
		panic("failed to parse templates: " + err.Error())
	}
}

type rateLimiter struct {
	mu       sync.Mutex
	visitors map[string]*visitor
	rate     int
	window   time.Duration
}

type visitor struct {
	count       int
	windowStart time.Time
}

func newRateLimiter(rate int, window time.Duration) *rateLimiter {
	rl := &rateLimiter{
		visitors: make(map[string]*visitor),
		rate:     rate,
		window:   window,
	}
	go rl.cleanup()
	return rl
}

func (rl *rateLimiter) cleanup() {
	for {
		time.Sleep(time.Minute)
		rl.mu.Lock()
		for ip, v := range rl.visitors {
			if time.Since(v.windowStart) > rl.window {
				delete(rl.visitors, ip)
			}
		}
		rl.mu.Unlock()
	}
}

// allow reports whether the visitor is under the limit, and whether this is the
// first rejected request in its window. Only the first rejection is logged, so a
// visitor hammering the site produces one warning per window rather than one per
// request (warnings are shipped to monitor).
func (rl *rateLimiter) allow(key string) (allowed, firstBlock bool) {
	rl.mu.Lock()
	defer rl.mu.Unlock()

	v, exists := rl.visitors[key]
	now := time.Now()

	if !exists || now.Sub(v.windowStart) > rl.window {
		rl.visitors[key] = &visitor{count: 1, windowStart: now}
		return true, false
	}

	v.count++
	return v.count <= rl.rate, v.count == rl.rate+1
}

// warnNoRealIP makes the "proxy is not sending X-Real-IP" warning fire once for
// the life of the process rather than once per request.
var warnNoRealIP sync.Once

// clientKey derives the rate-limiter bucket for a request.
//
// spiro runs behind Caddy on 127.0.0.1, so r.RemoteAddr is the proxy rather
// than the visitor. Keying on it puts every visitor in one bucket. The visitor
// address has to come from a header the client cannot forge:
//
//   - X-Real-IP is set by Caddy with `header_up X-Real-IP {client_ip}`, which
//     overwrites whatever the client sent.
//   - Failing that, the last X-Forwarded-For hop is the address Caddy itself
//     appended. Coarser, but still unforgeable.
//
// CF-Connecting-IP is deliberately not consulted: the origin answers on :443
// directly, so a request that skips Cloudflare can set it to anything.
//
// Headers are consulted only when the request arrived over loopback. If spiro
// is ever exposed directly, the peer address is the only truth.
func clientKey(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}

	peer, err := netip.ParseAddr(host)
	if err != nil {
		return host
	}
	if !peer.IsLoopback() {
		return bucketFor(peer)
	}

	if ip, ok := parseIP(r.Header.Get("X-Real-IP")); ok {
		return bucketFor(ip)
	}

	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		hops := strings.Split(xff, ",")
		if ip, ok := parseIP(hops[len(hops)-1]); ok {
			warnNoRealIP.Do(func() {
				slog.Warn("proxy is not setting X-Real-IP - rate limiting is per proxy hop, not per visitor",
					"fix", "add `header_up X-Real-IP {client_ip}` to the spiro reverse_proxy block")
			})
			return bucketFor(ip)
		}
	}

	return bucketFor(peer)
}

func parseIP(s string) (netip.Addr, bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return netip.Addr{}, false
	}
	if ip, err := netip.ParseAddr(s); err == nil {
		return ip, true
	}
	if ap, err := netip.ParseAddrPort(s); err == nil {
		return ap.Addr(), true
	}
	return netip.Addr{}, false
}

// bucketFor canonicalises an address into a limiter key, grouping IPv6 by /64
// so one subscriber can't mint a fresh bucket per request from their own prefix.
func bucketFor(ip netip.Addr) string {
	ip = ip.Unmap().WithZone("")
	if ip.Is6() {
		if p, err := ip.Prefix(64); err == nil {
			return p.String()
		}
	}
	return ip.String()
}

func rateLimit(limiter *rateLimiter, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		key := clientKey(r)
		allowed, firstBlock := limiter.allow(key)
		if firstBlock {
			slog.Warn("rate limit exceeded", "visitor", key, "limit", limiter.rate, "window", limiter.window.String())
		}
		if !allowed {
			http.Error(w, "Too Many Requests", http.StatusTooManyRequests)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func requestLogger(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		next.ServeHTTP(w, r)
		slog.Info("request", "method", r.Method, "uri", r.RequestURI, "duration", time.Since(start))
	})
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Referrer-Policy", "strict-origin-when-cross-origin")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; media-src 'self' blob:")
		next.ServeHTTP(w, r)
	})
}

func cacheStaticAssets(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "public, max-age=604800, immutable")
		next.ServeHTTP(w, r)
	})
}

var limiter = newRateLimiter(60, time.Minute)

func makeServerFromMux(mux *http.ServeMux) *http.Server {
	return &http.Server{
		ReadTimeout:  5 * time.Second,
		WriteTimeout: 10 * time.Second,
		IdleTimeout:  60 * time.Second,
		Handler:      requestLogger(rateLimit(limiter, securityHeaders(mux))),
	}
}

func makeHTTPServer() *http.Server {
	mux := &http.ServeMux{}
	mux.HandleFunc("/", handleIndex)
	mux.HandleFunc("/about", handleAbout)
	mux.HandleFunc("/health", handleHealth)
	mux.HandleFunc("/favicon.ico", handleFavicon)
	path, _ := os.Getwd()
	slog.Info("Working directory", "path", path)
	fileServer := http.FileServer(http.Dir(path + "/static"))
	mux.Handle("/static/", http.StripPrefix("/static/", cacheStaticAssets(fileServer)))
	return makeServerFromMux(mux)
}

func main() {
	httpPort := os.Getenv("PORT")
	if httpPort == "" {
		httpPort = "8484"
	}
	httpPort = ":" + httpPort

	// Set up log shipping to monitor portal
	monitorURL := os.Getenv("MONITOR_URL")
	monitorKey := os.Getenv("MONITOR_API_KEY")

	if monitorURL != "" && monitorKey != "" {
		ship := logship.New(logship.Options{
			Endpoint: monitorURL + "/api/logs",
			APIKey:   monitorKey,
			App:      "spiro",
			Level:    slog.LevelWarn,
		})
		defer ship.Shutdown()

		logger := slog.New(logship.Multi(
			slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo}),
			ship,
		))
		slog.SetDefault(logger)
		slog.Warn("spiro app started, log shipping active", "endpoint", monitorURL+"/api/logs")
	} else {
		slog.SetDefault(slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo})))
	}

	slog.Info("HTTP Port", "port", httpPort)

	httpSrv := makeHTTPServer()
	httpSrv.Addr = httpPort

	go func() {
		slog.Info("Starting HTTP server", "addr", httpSrv.Addr)
		if err := httpSrv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			slog.Error("httpSrv.ListenAndServe() failed", "error", err)
			os.Exit(1)
		}
	}()

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit
	slog.Info("Shutting down server...")

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := httpSrv.Shutdown(ctx); err != nil {
		slog.Error("Server forced to shutdown", "error", err)
	}

	slog.Info("Server exited")
}

func handleIndex(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		handle404(w, r)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := templates.ExecuteTemplate(w, "index.html", nil); err != nil {
		slog.Error("Error executing index template", "error", err)
		http.Error(w, "Internal Server Error", http.StatusInternalServerError)
	}
}

func handleAbout(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := templates.ExecuteTemplate(w, "about.html", nil); err != nil {
		slog.Error("Error executing about template", "error", err)
		http.Error(w, "Internal Server Error", http.StatusInternalServerError)
	}
}

// handleHealth is the uptime-monitor endpoint. spiro has no database or upstream
// to check, so a process that answers at all is a healthy one.
func handleHealth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/plain")
	w.Header().Set("Cache-Control", "no-store")
	w.Write([]byte("ok"))
}

func handleFavicon(w http.ResponseWriter, r *http.Request) {
	http.ServeFile(w, r, "favicon.ico")
}

func handle404(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(http.StatusNotFound)
	if err := templates.ExecuteTemplate(w, "404.html", nil); err != nil {
		slog.Error("Error executing 404 template", "error", err)
	}
}
