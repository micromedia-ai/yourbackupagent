# Kit runner: runs dagangilat/yourbackupagent's kit/backup.sh (the version a
# project pins with KIT_REF) as a Cloud Run job, for the manager app's
# rebuild drills and drill-project wipes. Started only by the app's API.
FROM gcr.io/google.com/cloudsdktool/google-cloud-cli:slim
ARG GH_VERSION=2.62.0
RUN apt-get update \
 && apt-get install -y --no-install-recommends jq git curl ca-certificates \
 && curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.tar.gz" \
    | tar -xz -C /opt \
 && ln -s "/opt/gh_${GH_VERSION}_linux_amd64/bin/gh" /usr/local/bin/gh \
 && rm -rf /var/lib/apt/lists/*
COPY entry.sh /entry.sh
RUN chmod +x /entry.sh
ENTRYPOINT ["/entry.sh"]
