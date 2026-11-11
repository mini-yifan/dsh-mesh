# dsh-mesh deploy (v0)

Self-signed certificate, Caddy TLS termination, one `dsh-mesh` container and a
JSON data volume. The public listener only exposes the device control plane;
the admin page stays on `127.0.0.1:8080` and is reached through an SSH tunnel.

## 1. Generate the certificate (once)

```bash
cd deploy
mkdir -p certs
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout certs/key.pem -out certs/cert.pem -days 3650 \
  -subj "/CN=$SERVER_IP" \
  -addext "subjectAltName=IP:$SERVER_IP"
openssl x509 -in certs/cert.pem -pubkey -noout \
  | openssl pkey -pubin -outform der \
  | openssl dgst -sha256 -binary \
  | openssl base64 -A | tr '+/' '-_' | tr -d '='
```

The last line is the SPKI fingerprint written into `server.env` and embedded in
every pairing string. Keep the same key when rotating the certificate: the
fingerprint is pinned by every device.

## 2. Write `server.env`

```bash
cp server.env.example server.env
chmod 600 server.env
```

Fill in the admin password (>= 12 chars, this is also the admin-page password),
the public URL (`https://<server-ip>`) and the fingerprint from step 1.

## 3. Start

```bash
docker compose up -d --build
curl -k https://127.0.0.1/health
```

`/health` must return `{"status":"ok","meshApi":1}`. `curl` without `-k` must
fail because the certificate is self-signed.

## 4. Admin page

```bash
ssh -L 8080:127.0.0.1:8080 root@<server-ip>
# open http://127.0.0.1:8080
```

The public 443 listener returns 404 for `/api/v1/admin/*`, `/api/v1/auth/login`
and the SPA; only the device APIs and the WebSocket upgrade are proxied.