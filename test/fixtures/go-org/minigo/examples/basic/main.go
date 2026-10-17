package main

import "github.com/acme/minigo"

func main() {
	db, _ := minigo.Connect(&minigo.Options{})
	db.SelectGraph("social").ROQuery("MATCH (n) RETURN n", nil)
}
