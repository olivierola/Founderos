// Package founderos is the FounderOS analytics SDK for Go (server-side).
//
// It buffers product events and flushes them in batches to the track-event edge
// function. Authenticate with an "fos_" API key (Integrations → API Keys); the
// workspace is resolved from the key, so only the project id is required.
//
//	fos := founderos.New(founderos.Config{
//	    Host:      "https://xxxx.supabase.co",
//	    ProjectID: "<project-uuid>",
//	    APIKey:    "fos_...",
//	})
//	defer fos.Shutdown(context.Background())
//
//	fos.Track("signup", founderos.Event{
//	    DistinctID: "user@example.com",
//	    Properties: map[string]any{"plan": "pro"},
//	})
//
// Only depends on the standard library.
package founderos

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

// Config configures a Client.
type Config struct {
	Host        string // Supabase project URL, e.g. https://xxxx.supabase.co
	ProjectID   string // target project (cockpit) UUID
	APIKey      string // server key "fos_..." (preferred on the server)
	WorkspaceID string // required only if APIKey is empty
	AnonKey     string // required only if APIKey is empty
	BatchSize   int    // flush when this many events are buffered (default 20)
	FlushEvery  time.Duration
	MaxQueue    int  // cap on buffered events (default 10000)
	Debug       bool
	HTTPClient  *http.Client
}

// Event is a single tracked event.
type Event struct {
	DistinctID string         // user identifier (email or your own id)
	Properties map[string]any // arbitrary properties
	OccurredAt time.Time      // zero => now
}

type wireEvent struct {
	EventName  string         `json:"event_name"`
	DistinctID string         `json:"distinct_id,omitempty"`
	Properties map[string]any `json:"properties,omitempty"`
	OccurredAt string         `json:"occurred_at,omitempty"`
}

// Client is a batching event tracker. Safe for concurrent use.
type Client struct {
	cfg    Config
	http   *http.Client
	mu     sync.Mutex
	queue  []wireEvent
	stop   chan struct{}
	wg     sync.WaitGroup
	closed bool
}

// New creates a Client and starts the background flusher (unless FlushEvery==0).
func New(cfg Config) *Client {
	if cfg.Host == "" || cfg.ProjectID == "" {
		panic("founderos: Host and ProjectID are required")
	}
	if cfg.APIKey == "" && (cfg.WorkspaceID == "" || cfg.AnonKey == "") {
		panic("founderos: provide APIKey (server) or WorkspaceID + AnonKey")
	}
	if cfg.BatchSize <= 0 {
		cfg.BatchSize = 20
	}
	if cfg.MaxQueue <= 0 {
		cfg.MaxQueue = 10000
	}
	if cfg.FlushEvery == 0 {
		cfg.FlushEvery = 5 * time.Second
	}
	httpClient := cfg.HTTPClient
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 10 * time.Second}
	}
	c := &Client{
		cfg:  cfg,
		http: httpClient,
		stop: make(chan struct{}),
	}
	if cfg.FlushEvery > 0 {
		c.wg.Add(1)
		go c.loop()
	}
	return c
}

// Track queues an event. It is sent on the next flush, or immediately once the
// buffer reaches BatchSize.
func (c *Client) Track(eventName string, e Event) {
	occurred := ""
	if !e.OccurredAt.IsZero() {
		occurred = e.OccurredAt.UTC().Format(time.RFC3339)
	}
	we := wireEvent{
		EventName:  eventName,
		DistinctID: e.DistinctID,
		Properties: e.Properties,
		OccurredAt: occurred,
	}
	c.mu.Lock()
	c.queue = append(c.queue, we)
	if len(c.queue) > c.cfg.MaxQueue {
		c.queue = c.queue[len(c.queue)-c.cfg.MaxQueue:]
	}
	full := len(c.queue) >= c.cfg.BatchSize
	c.mu.Unlock()
	if full {
		_ = c.Flush(context.Background())
	}
}

// Flush sends all queued events now.
func (c *Client) Flush(ctx context.Context) error {
	c.mu.Lock()
	if len(c.queue) == 0 {
		c.mu.Unlock()
		return nil
	}
	batch := c.queue
	c.queue = nil
	c.mu.Unlock()

	body := map[string]any{
		"project_id": c.cfg.ProjectID,
		"batch":      batch,
	}
	if c.cfg.WorkspaceID != "" {
		body["workspace_id"] = c.cfg.WorkspaceID
	}
	if err := c.post(ctx, "track-event", body); err != nil {
		// Re-queue so events aren't lost.
		c.mu.Lock()
		c.queue = append(batch, c.queue...)
		if len(c.queue) > c.cfg.MaxQueue {
			c.queue = c.queue[len(c.queue)-c.cfg.MaxQueue:]
		}
		c.mu.Unlock()
		c.log("flush failed, re-queued: %v", err)
		return err
	}
	c.log("flushed %d events", len(batch))
	return nil
}

// Shutdown stops the background flusher and flushes remaining events.
func (c *Client) Shutdown(ctx context.Context) error {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return nil
	}
	c.closed = true
	c.mu.Unlock()
	close(c.stop)
	c.wg.Wait()
	return c.Flush(ctx)
}

func (c *Client) loop() {
	defer c.wg.Done()
	t := time.NewTicker(c.cfg.FlushEvery)
	defer t.Stop()
	for {
		select {
		case <-c.stop:
			return
		case <-t.C:
			_ = c.Flush(context.Background())
		}
	}
}

func (c *Client) post(ctx context.Context, fn string, body any) error {
	buf, err := json.Marshal(body)
	if err != nil {
		return err
	}
	url := strings.TrimRight(c.cfg.Host, "/") + "/functions/v1/" + fn
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(buf))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if c.cfg.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+c.cfg.APIKey)
	}
	if c.cfg.AnonKey != "" {
		req.Header.Set("apikey", c.cfg.AnonKey)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 200))
		return fmt.Errorf("%s %d: %s", fn, resp.StatusCode, string(b))
	}
	return nil
}

func (c *Client) log(format string, args ...any) {
	if c.cfg.Debug {
		fmt.Printf("[founderos] "+format+"\n", args...)
	}
}
