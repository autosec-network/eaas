# syntax=docker/dockerfile:1
# https://docs.docker.com/build/dockerfile/release-notes/
# https://gist.github.com/demosjarco/875db677712636c09b79dc7a47f05231

# ---------- Production Stage ----------
FROM --platform=linux/amd64 node:22.16.0-alpine@sha256:41e4389f3d988d2ed55392df4db1420ad048ae53324a8e2b7c6d19508288107e

RUN --mount=type=cache,target=/var/cache/apk apk update
RUN --mount=type=cache,target=/var/cache/apk apk upgrade
RUN --mount=type=cache,target=/var/cache/apk apk cache clean
RUN --mount=type=cache,target=/var/cache/apk apk del --purge

# Create and change to the api directory.
WORKDIR /app
RUN mkdir -p /app/api && chown -R node:node /app

# By default, Docker runs commands inside the container as root which violates the Principle of Least Privilege when superuser permissions are not strictly required (you want to run the container as an unprivileged user whenever possible). The node images provide the node user for such purpose
USER node

LABEL org.opencontainers.image.source="https://github.com/autosec-network/eaas.git"

# Copy package.json and package-lock.json for utilising Docker cache 
COPY package*.json ./
COPY api/package*.json ./api/

# Install only production dependencies phase with access to secrets
RUN --mount=type=cache,target=/root/.npm npm ci --include-workspace-root -w api --ignore-scripts --omit=dev
# Build phase with no access to secrets
RUN --mount=type=cache,target=/root/.npm npm run-script install --if-present
# Slim down image
RUN --mount=type=cache,target=/root/.npm npm cache clean --force

# Copy built application from the build stage
COPY api/pqc/container/dist ./api/pqc/container/dist

# Run the web service on container startup.
CMD ["npm", "-w", "api", "run", "start:pqc"]
    