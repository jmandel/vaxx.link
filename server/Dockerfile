FROM denoland/deno:1.25.2
EXPOSE 8000
WORKDIR /app
USER deno
COPY  --chown=deno deps.ts .
RUN deno cache deps.ts
COPY --chown=deno . .
RUN deno cache server.ts
#TODO review logging docs RUN mkdir -p /var/tmp/log
CMD ["run", "--allow-all", "server.ts"]
