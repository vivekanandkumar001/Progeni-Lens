"""Tiny local server with correct MIME types for .mjs and .wasm files."""

import functools
import http.server
import mimetypes

mimetypes.add_type("text/javascript", ".mjs")
mimetypes.add_type("application/wasm", ".wasm")

handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=".")
server = http.server.ThreadingHTTPServer(("127.0.0.1", 8011), handler)

print("Progeni Lens running at http://127.0.0.1:8011")
server.serve_forever()
