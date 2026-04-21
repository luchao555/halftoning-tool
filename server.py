import http.server
import socketserver

class SecureHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        self.send_header('Cross-Origin-Embedder-Policy', 'require-corp')
        super().end_headers()

    def log_message(self, format, *args):
        pass  # silence logs

with socketserver.TCPServer(('', 8080), SecureHandler) as httpd:
    print('http://localhost:8080')
    httpd.serve_forever()