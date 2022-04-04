FROM denoland/deno:1.20.4
EXPOSE 8000
WORKDIR /app
USER deno
COPY deps.ts .
RUN deno cache deps.ts
COPY . .
RUN deno cache server.ts
#TODO review logging docs RUN mkdir -p /var/tmp/log
CMD ["run", "--allow-all", "server.ts"]
