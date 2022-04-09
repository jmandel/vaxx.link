# SHLinks Demo Server

* Creates new SHLinks and adds files to them
* Authorizes access
* Shares files with authorized clients'

# Run
```
deno run --allow-env="PORT" --allow-read=".","./db" --allow-write="./db" --allow-net --watch server.ts
```

# Test

```sh
deno test --allow-env="PORT" --allow-read=".","./db" --allow-write="./db" --allow-net
```

# Build in Docker

```sh
docker build -t vaxx.link .
docker run --rm -it -p 8000:8000 vaxx.link
```
