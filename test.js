import http from "http";

const server = http.createServer((req, res) => {
  res.end("WORKING");
});

server.listen(5050, "127.0.0.1", () => {
  console.log("Server on 127.0.0.1:5050");
});
