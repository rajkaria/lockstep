package wire

type Conn struct{ addr string }

func Dial(addr string) *Conn { return &Conn{addr: addr} }

func (c *Conn) Close() error { return nil }
