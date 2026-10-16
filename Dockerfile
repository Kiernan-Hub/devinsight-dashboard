# The ingest API as a container image: server.mjs running api/ingest.js.
#
#   docker build -t devinsight-ingest .
#
# Small on purpose. The repository has no npm dependencies, so there is no `npm install`
# step and no node_modules: the image is the Node runtime plus five source files.

# Pinned to an exact image digest as well as a tag. A tag like `24-alpine` is a moving pointer
# that is re-published every time Node or Alpine ships a patch, so the same Dockerfile could
# build a different image tomorrow. The digest makes the build reproducible; Dependabot (see
# .github/dependabot.yml) proposes digest bumps as reviewable pull requests.
FROM node:24-alpine@sha256:44fce696f38ba8c987c4db89954051000bbd05ffd8d8659ba15ed4a8602e937f

WORKDIR /app

# An explicit list, not `COPY . .`. The build context is already narrowed by .dockerignore,
# but naming each file here means nothing ends up in the image by accident — in particular not
# ascent/ (the game, kept out of this repository's public surface on purpose) or a local .env.
# package.json is needed for one line: "type": "module", which makes api/ingest.js an ES module.
COPY package.json server.mjs ./
COPY api/ingest.js ./api/
COPY lib/ingest-core.mjs lib/node-server.mjs ./lib/

# The official Node image ships an unprivileged `node` user, uid 1000. Running as root inside a
# container is not the same as root on the host, but it is one kernel bug away from it, and a web
# server has no reason to need it. Given as numbers rather than the name: a runtime can only
# verify "this is not root" from a numeric id (Kubernetes' runAsNonRoot refuses a named user it
# cannot resolve), and hadolint flags the named form for exactly that reason.
USER 1000:1000

ENV PORT=8787
EXPOSE 8787

# Hits /healthz, which answers without touching the database (see lib/node-server.mjs). Uses
# Node's built-in fetch because the Alpine image has no curl, and adding one just for this
# would be a package installed only to be attack surface.
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + process.env.PORT + '/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

# Exec form, so Node is process 1 and receives `docker stop`'s SIGTERM directly; server.mjs
# handles it by finishing in-flight requests before exiting.
CMD ["node", "server.mjs"]
