# Go client

Install it with `go get github.com/acme/minigo`.

```go
package main

import (
	"fmt"

	"github.com/acme/minigo"
)

func main() {
	db, err := minigo.Connect(&minigo.Options{Addr: minigo.DefaultAddr})
	if err != nil {
		panic(err)
	}
	g := db.SelectGraph("social")
	res, _ := g.Query("MATCH (n) RETURN n", nil)
	for res.Next() {
		v, _ := res.Record().Get("n")
		fmt.Println(v)
	}
	g.Query("MATCH (n) RETURN n", nil, minigo.WithTimeout(10))
	g.ROQuery("MATCH (n) RETURN n")
	g.Gone()
	g.run("x")
	minigo.newConn("x")
	db.Close(1)
}
```

A fragment, with the page's imports:

```go
db, _ := minigo.Connect(nil)
db.SelectGraph()
minigo.Missing()
```

```go
import mg "github.com/acme/minigo"

c, _ := mg.Connect(nil)
c.SelectGraph("a", "b")
```

```go
import (
	"github.com/acme/minigo/gone"
	"github.com/acme/minigo/examples/basic"
)
```
