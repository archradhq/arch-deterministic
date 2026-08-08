// Go encodes major versions from v2 onward in the module path. The last
// segment is the version, not the module — naming from it produced "v3".
// argo-cd's real go.mod is exactly this shape.
module github.com/argoproj/argo-cd/v3

go 1.23

require (
	github.com/lib/pq v1.10.9
)
