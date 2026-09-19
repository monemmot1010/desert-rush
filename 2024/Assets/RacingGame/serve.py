"""خادم تطوير: يخدم ملفات اللعبة مع Cache-Control: no-store."""
import http.server
import functools

class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        super().end_headers()

if __name__ == '__main__':
    http.server.test(HandlerClass=functools.partial(NoCacheHandler, directory='.'), port=8123, bind='127.0.0.1')
