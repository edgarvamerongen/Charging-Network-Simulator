# Gunicorn config — Charging Network Simulator
# Sized for a handful of concurrent users (client + friends).
bind = "127.0.0.1:5055"     # Caddy proxies here; never exposed to the LAN/internet directly
workers = 2                 # each worker loads the airport CSV into pandas (~tens of MB)
worker_class = "gthread"
threads = 4
timeout = 60
accesslog = "-"             # → stdout → journald (journalctl -u cns)
errorlog = "-"
