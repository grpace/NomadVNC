package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/nomadvnc/nomadvnc/go-core/internal/session"
)

func TestServeAnswersFastRequestsWhileASlowOneIsInFlight(t *testing.T) {
	inReader, inWriter := io.Pipe()
	outReader, outWriter := io.Pipe()
	writer := &responseWriter{out: outWriter}
	release := make(chan struct{})

	done := make(chan struct{})
	go func() {
		serve(inReader, writer, func(request session.Request) {
			if request.Method == "slow" {
				<-release
			}
			writer.write(session.Response{ID: request.ID, OK: true})
		})
		close(done)
	}()

	_, _ = io.WriteString(inWriter, `{"id":"1","method":"slow"}`+"\n")
	_, _ = io.WriteString(inWriter, `{"id":"2","method":"fast"}`+"\n")

	lines := bufio.NewScanner(outReader)
	first := make(chan string, 1)
	go func() {
		if lines.Scan() {
			first <- lines.Text()
		}
	}()

	select {
	case line := <-first:
		var response session.Response
		if err := json.Unmarshal([]byte(line), &response); err != nil {
			t.Fatalf("bad response %q: %v", line, err)
		}
		if response.ID != "2" {
			t.Fatalf("first reply was for %q, want the fast request 2", response.ID)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("fast request was blocked behind the slow one")
	}

	close(release)
	if !lines.Scan() || !strings.Contains(lines.Text(), `"id":"1"`) {
		t.Fatalf("slow request never answered: %q", lines.Text())
	}
	_ = inWriter.Close()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("serve did not return after input closed")
	}
}

func TestServeReportsMalformedLines(t *testing.T) {
	var out bytes.Buffer
	writer := &responseWriter{out: &out}
	serve(strings.NewReader("{not json\n"), writer, func(session.Request) {
		t.Fatal("handler must not run for malformed input")
	})
	if !strings.Contains(out.String(), `"ok":false`) {
		t.Fatalf("expected an error reply, got %q", out.String())
	}
}
