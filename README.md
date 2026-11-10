start tunnel

cloudflared tunnel --protocol http2 --url http://localhost:8080 --no-autoupdate


two servers one is in python and one is in rust, the binary is not included you need to build it yourself with rustc 
```
$rustc server.rs -o rust-server
$./rust-server
```
