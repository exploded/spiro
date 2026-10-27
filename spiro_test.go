package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func newReq(remote string, headers map[string]string) *http.Request {
	r := httptest.NewRequest("GET", "/", nil)
	r.RemoteAddr = remote
	for k, v := range headers {
		r.Header.Set(k, v)
	}
	return r
}

func TestClientKeyPrefersCaddyRealIP(t *testing.T) {
	r := newReq("127.0.0.1:50000", map[string]string{
		"X-Real-IP":       "203.0.113.7",
		"X-Forwarded-For": "198.51.100.1, 203.0.113.7",
	})
	if got := clientKey(r); got != "203.0.113.7" {
		t.Errorf("clientKey = %q, want 203.0.113.7", got)
	}
}

func TestClientKeyFallsBackToLastForwardedHop(t *testing.T) {
	r := newReq("127.0.0.1:50000", map[string]string{
		"X-Forwarded-For": "1.2.3.4, 203.0.113.9",
	})
	if got := clientKey(r); got != "203.0.113.9" {
		t.Errorf("clientKey = %q, want 203.0.113.9", got)
	}
}

func TestClientKeyIgnoresHeadersFromNonLoopbackPeer(t *testing.T) {
	r := newReq("198.51.100.5:40000", map[string]string{
		"X-Real-IP": "1.1.1.1",
	})
	if got := clientKey(r); got != "198.51.100.5" {
		t.Errorf("clientKey = %q, want 198.51.100.5", got)
	}
}

func TestClientKeyIgnoresCFConnectingIP(t *testing.T) {
	r := newReq("127.0.0.1:50000", map[string]string{
		"X-Real-IP":        "203.0.113.7",
		"CF-Connecting-IP": "9.9.9.9",
	})
	if got := clientKey(r); got != "203.0.113.7" {
		t.Errorf("clientKey = %q, want 203.0.113.7", got)
	}
}

func TestClientKeyGroupsIPv6By64(t *testing.T) {
	a := clientKey(newReq("[2001:db8:1:2::1]:443", nil))
	b := clientKey(newReq("[2001:db8:1:2:ffff::9]:443", nil))
	if a != b || a != "2001:db8:1:2::/64" {
		t.Errorf("keys = %q, %q, want both 2001:db8:1:2::/64", a, b)
	}
}

func TestRateLimitIsPerVisitor(t *testing.T) {
	rl := &rateLimiter{visitors: map[string]*visitor{}, rate: 2, window: time.Minute}
	h := rateLimit(rl, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))

	hit := func(ip string) int {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, newReq("127.0.0.1:50000", map[string]string{"X-Real-IP": ip}))
		return w.Code
	}

	hit("203.0.113.1")
	hit("203.0.113.1")
	if code := hit("203.0.113.1"); code != http.StatusTooManyRequests {
		t.Errorf("third request from same visitor = %d, want 429", code)
	}
	if code := hit("203.0.113.2"); code != http.StatusOK {
		t.Errorf("first request from another visitor = %d, want 200", code)
	}
}

func TestRateLimitReportsFirstBlockOnly(t *testing.T) {
	rl := &rateLimiter{visitors: map[string]*visitor{}, rate: 1, window: time.Minute}
	rl.allow("a")
	if _, first := rl.allow("a"); !first {
		t.Error("first rejection not reported")
	}
	if _, first := rl.allow("a"); first {
		t.Error("second rejection reported again")
	}
}

func TestHealth(t *testing.T) {
	w := httptest.NewRecorder()
	handleHealth(w, httptest.NewRequest("GET", "/health", nil))
	if w.Code != http.StatusOK || w.Body.String() != "ok" {
		t.Errorf("health = %d %q, want 200 \"ok\"", w.Code, w.Body.String())
	}
}

func TestHandleIndex(t *testing.T) {
	w := httptest.NewRecorder()
	handleIndex(w, httptest.NewRequest("GET", "/", nil))
	if w.Code != http.StatusOK {
		t.Errorf("index = %d, want 200", w.Code)
	}
}

func TestHandleIndexNotFound(t *testing.T) {
	w := httptest.NewRecorder()
	handleIndex(w, httptest.NewRequest("GET", "/nope", nil))
	if w.Code != http.StatusNotFound {
		t.Errorf("unknown path = %d, want 404", w.Code)
	}
}

func TestAbout(t *testing.T) {
	w := httptest.NewRecorder()
	handleAbout(w, httptest.NewRequest("GET", "/about", nil))
	if w.Code != http.StatusOK {
		t.Errorf("about = %d, want 200", w.Code)
	}
}
