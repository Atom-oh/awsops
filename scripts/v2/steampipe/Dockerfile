# Docker Hub AND ghcr turbot/steampipe are frozen at 0.22.0 (last published 2024-03; the
# Steampipe/Powerpipe/Tailpipe split ended container publishing). 0.22.0's built-in plugin
# registry endpoint (us-docker.pkg.dev) now returns 403 for unauthenticated pulls, so the bare
# `steampipe plugin install aws` fails. Workaround: install the aws plugin from its new ghcr home
# via a full OCI ref, then relocate it to the hub.steampipe.io/... path the connection resolver
# expects (a short-name connection resolves to hub.steampipe.io/plugins/turbot/aws@<ver>), and
# rewrite versions.json so `steampipe plugin list` sees it installed under that canonical name.
# aws plugin uses 0.x versioning (no 1.x); 0.142.0 (plugin-sdk v5.10.0) is protocol-compatible with
# steampipe 0.22.0 (plugin-sdk v5.9.0) — the gRPC protocol stayed at 20 across SDK v5. Pinned = deterministic schema.
FROM turbot/steampipe:0.22.0
RUN steampipe plugin install "ghcr.io/turbot/steampipe/plugins/turbot/aws:0.142.0" \
 && P=/home/steampipe/.steampipe/plugins \
 && mkdir -p "$P/hub.steampipe.io/plugins/turbot" \
 && cp -a "$P/ghcr.io/turbot/steampipe/plugins/turbot/aws@0.142.0" "$P/hub.steampipe.io/plugins/turbot/aws@0.142.0" \
 && sed -i 's#ghcr.io/turbot/steampipe/plugins/turbot/aws#hub.steampipe.io/plugins/turbot/aws#g' "$P/versions.json" \
 && rm -rf "$P/ghcr.io"
# aws.spc = version-pinned connection (plugin = "aws@0.142.0") + default cred chain (Fargate task role)
COPY --chown=steampipe:0 aws.spc /home/steampipe/.steampipe/config/aws.spc
EXPOSE 9193
# network listener so the in-VPC sync Lambda can reach it; password via env STEAMPIPE_DATABASE_PASSWORD
ENTRYPOINT ["steampipe", "service", "start", "--database-listen", "network", "--database-port", "9193", "--foreground"]
