package minigo

import (
	"errors"

	"github.com/acme/minigo/internal/wire"
)

// ErrClosed is returned after Close.
var ErrClosed = errors.New("closed")

const DefaultAddr = "localhost:6379"

type Options struct {
	Addr    string
	Timeout int
}

type Client struct {
	opts Options
	conn *wire.Conn
}

// Connect opens a client.
func Connect(opts *Options) (*Client, error) {
	return &Client{opts: *opts, conn: wire.Dial(opts.Addr)}, nil
}

func (c *Client) SelectGraph(name string) *Graph {
	return &Graph{client: c, Name: name}
}

func (c *Client) Close() error {
	return c.conn.Close()
}

func newConn(addr string) *wire.Conn {
	return wire.Dial(addr)
}
