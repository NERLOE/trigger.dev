# Webapp

```shell
depot build \
  --platform linux/amd64 \
  -f docker/Dockerfile \
  --build-arg BUILD_APP_VERSION=spaak-version \
  --build-arg BUILD_GIT_SHA=$(git rev-parse HEAD) \
  --build-arg BUILD_GIT_REF_NAME=spaak-version \
  --build-arg BUILD_TIMESTAMP_SECONDS=$(date +%s) \
  -t ghcr.io/spaak-technologies/trigger-webapp:latest \
  --push \
  .
```


# Supervisor

```shell
depot build \
  --platform linux/amd64 \
  -f apps/supervisor/Containerfile \
  -t ghcr.io/spaak-technologies/trigger-supervisor:latest \
  --push \
  .
```