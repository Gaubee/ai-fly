// e2e 辅助：列出 provider fabric 的成员（JSON 到 stdout）。
// 用法：node _fabric-members.mjs <providerDataDir> <relayUrl>
// 与运行中的 serve 进程并发打开同一 dataDir 是安全的（dweb e2e 同手法）。
import { join } from "node:path";
import opendweb from "@jixo/opendweb-client-sdk";

const { Fabric } = opendweb;
const [dataDir, relayUrl] = process.argv.slice(2);
const fabric = await Fabric.open({
  dataDir: join(dataDir, "fabric"),
  ...(relayUrl ? { relay: { mode: "custom", urls: [relayUrl] } } : {}),
});
try {
  const members = await fabric.members();
  console.log(JSON.stringify({ self: fabric.endpointId, members }));
} finally {
  await fabric.shutdown();
}
