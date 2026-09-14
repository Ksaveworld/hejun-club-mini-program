# Include only within the existing example.com HTTPS server block.
# Business login remains disabled until private WeChat configuration AND invitations exist.
location ^~ /hejun-club-trial/api/ {
    client_max_body_size 16k;
    proxy_pass http://127.0.0.1:5210/api/;
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

# Public static preview; isolated from member APIs and other projects.
location = /hejun-club-preview { return 302 /hejun-club-preview/; }
location ^~ /hejun-club-preview/ {
    alias /usr/local/nginx/html/hejun-club-preview/;
    index index.html;
    autoindex off;
    add_header X-Robots-Tag "noindex, nofollow" always;
    add_header X-Content-Type-Options nosniff always;
    add_header Cache-Control "no-cache" always;
}

# Independent business web service deployed on this host; preserve during API updates.
include /data/hejun-club-web/nginx-web.inc;
