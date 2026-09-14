# Include within the existing HTTPS server through the project-owned nginx-api.inc.
location ^~ /hejun-club/api/ {
    client_max_body_size 16k;
    proxy_pass http://127.0.0.1:5211/api/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For "";
    proxy_set_header Forwarded "";
    proxy_set_header Connection "";
    proxy_connect_timeout 5s;
    proxy_read_timeout 15s;
    proxy_send_timeout 15s;
}
location = /hejun-club { return 302 /hejun-club/; }
location ^~ /hejun-club/ {
    alias /usr/local/nginx/html/hejun-club/;
    index index.html;
    autoindex off;
    add_header Cache-Control "no-cache" always;
    add_header X-Robots-Tag "noindex, nofollow" always;
    add_header X-Content-Type-Options nosniff always;
}
