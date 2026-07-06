-- 024_agent_tls_cert.sql
-- Studio<->bridge TLS cert pinning. Managed Pro droplets now serve the bridge
-- over HTTPS with a self-signed cert that Studio generates at provision time and
-- pins on every call. We store the exact cert PEM here so Studio can pin it.
--
-- Nullable, no backfill: existing http:// bridges keep external_tls_cert = NULL
-- and Studio talks plain HTTP to them (bridgeFetch keys off the URL scheme).
ALTER TABLE agents ADD COLUMN IF NOT EXISTS external_tls_cert text;

GRANT ALL ON TABLE agents TO brigata;
