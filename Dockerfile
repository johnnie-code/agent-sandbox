# The sandbox image an agent's commands run inside.
# git, node and a build toolchain only. No docker socket, no host mounts beyond the workspace.
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates python3 make g++ \
 && apt-get clean \
 && find /var/lib/apt/lists -type f -delete

# The agent's code lands in /workspace, mounted read-write by the server.
WORKDIR /workspace
ENV NODE_ENV=development CI=1

CMD ["bash"]
