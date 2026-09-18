# net-fly/wire-protocol 增量

## REMOVED Requirements

### Requirement: AUTH 握手（会话级授权，多密钥）

**Reason**: AUTH 改经 HTTP 端点（`/_aifly/auth`）承载于 opendweb 会话连续性
内核；envelope 帧族退役。

### Requirement: 请求多路复用

**Reason**: 多路复用由内核逻辑流（stream_id + 字节级 journal/去重）承接；
REQ/REQ_BODY/RESP 族帧退役。

### Requirement: 请求上行（REQ / REQ_BODY）

**Reason**: 请求上行经内核 HTTP 投影（OPEN 元数据 + DATA 帧）；aifly 帧
退役。

### Requirement: 响应下行（RESP_META / RESP_CHUNK / RESP_END / PING）

**Reason**: 响应下行经内核响应投影（首行 meta + DATA + FIN）；aifly 帧
退役。

### Requirement: WebSocket 升级通道（DATA_UP / DATA_DOWN / CLOSE）

**Reason**: WS 走内核 keepOpen 字节隧道（帧端到端不透明）；aifly DATA_UP/
DATA_DOWN/CLOSE 帧退役。

### Requirement: 接收侧缓冲上限（背压兜底）

**Reason**: 背压由内核 journal 上限与发送侧反压承接（接收侧去重窗口有界）；
应用层缓冲兜底退役。

## retained

「命名空间与版本隔离」「帧方向与未知标识符」随 wire/frames.ts schema
（share-link 依赖）保留；aifly envelope 传输面不再使用。
