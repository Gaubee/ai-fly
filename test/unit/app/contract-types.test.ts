// 契约编译期类型断言（shell spec「契约驱动全类型」）：以 ContractRouterClient
// 推导消费端类型，拼写错误的过程名/输入形状在编译期暴露（本文件运行时仅
// 恒真断言——它的价值全在 tsc --noEmit）。B 车道按同款类型写前端调用。

import { expect, it } from "vitest";
import type { ContractRouterClient } from "@orpc/contract";
import type { RpcContract } from "../../../src/shared/rpc-contract.ts";

/** 全类型 RPC client（webui 同款推导）。 */
export type Client = ContractRouterClient<RpcContract>;

type AssertEqual<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

// ---------------------------------------------------------------------------
// 过程存在性（拼写错误 → 编译失败）
// ---------------------------------------------------------------------------

type Probe =
  Client["provider"]["services"]["list"] &
    Client["provider"]["services"]["get"] &
    Client["provider"]["services"]["add"] &
    Client["provider"]["services"]["remove"] &
    Client["provider"]["groups"]["list"] &
    Client["provider"]["groups"]["add"] &
    Client["provider"]["groups"]["setServices"] &
    Client["provider"]["keys"]["issue"] &
    Client["provider"]["keys"]["list"] &
    Client["provider"]["keys"]["revoke"] &
    Client["provider"]["share"]["create"] &
    Client["provider"]["status"] &
    Client["provider"]["daemon"]["start"] &
    Client["provider"]["daemon"]["stop"] &
    Client["consumer"]["import"]["preview"] &
    Client["consumer"]["import"]["apply"] &
    Client["consumer"]["join"] &
    Client["consumer"]["key"]["add"] &
    Client["consumer"]["ports"]["list"] &
    Client["consumer"]["ports"]["set"] &
    Client["consumer"]["status"] &
    Client["consumer"]["forget"] &
    Client["consumer"]["gateway"]["start"] &
    Client["consumer"]["gateway"]["stop"] &
    Client["presets"]["list"] &
    Client["presets"]["applyAsService"] &
    Client["writers"]["preview"] &
    Client["writers"]["apply"] &
    Client["system"]["settings"]["get"] &
    Client["system"]["settings"]["set"] &
    Client["system"]["notifyChannels"];

// ---------------------------------------------------------------------------
// 输入形状（参数类型精确到字段）
// ---------------------------------------------------------------------------

/** services.add 的输入参数类型（hooks-lifecycle v2：四槽 + rewrite 瘦身）。 */
type ServicesAddInput = Parameters<Client["provider"]["services"]["add"]>[0];
const checkAddInput: AssertEqual<
  ServicesAddInput,
  {
    name: string;
    upstream: string;
    match: Array<{ type: "exact" | "suffix" | "regex"; value: string }>;
    defaultPort?: number | undefined;
    rewrite?:
      | {
          host?: string | undefined;
          pathPrefixStrip?: string | undefined;
          pathPrefixAppend?: string | undefined;
        }
      | undefined;
    auth?:
      | ({ secret: string; bearer?: boolean | undefined })
      | ({ script: string; args?: Record<string, string> | undefined; bearer?: boolean | undefined })
      | ({ literal: string; bearer?: boolean | undefined })
      | undefined;
    headers?:
      | {
          remove?: string[] | undefined;
          set?: Record<string, string> | undefined;
          script?: { name: string; args?: Record<string, string> | undefined } | undefined;
        }
      | undefined;
    request?: { script: string; args?: Record<string, string> | undefined } | undefined;
    response?: { script: string; args?: Record<string, string> | undefined } | undefined;
    routes?:
      | Array<{
          forms: Array<"openai-chat" | "openai-responses" | "anthropic">;
          mode?: "prefix" | "pattern" | undefined;
          localPrefix?: string | undefined;
          upstreamPrefix?: string | undefined;
          matchPattern?: string | undefined;
          template?: string | undefined;
        }>
      | undefined;
    enabled?: boolean | undefined;
  }
> = true;
void checkAddInput;

/** provider.status 输出的 legacy 态字段（hooks-lifecycle 2.3 最小增量）。 */
type ProviderStatusOutput = Awaited<ReturnType<Client["provider"]["status"]>>;
const checkStatusLegacy: AssertEqual<
  ProviderStatusOutput["legacy"],
  { serviceNames: string[] } | null
> = true;
void checkStatusLegacy;

/** hooks.list 输出 stages-only（hooks-lifecycle 5.1；codex R6：fns 字段删除）。 */
type HooksListOutput = Awaited<ReturnType<Client["provider"]["hooks"]["list"]>>;
const checkHooksStages: AssertEqual<
  HooksListOutput,
  {
    hooks: Array<{
      name: string;
      source: "user" | "builtin";
      stages: Array<
        "onRequestBearerAuthentication" | "onRequestHeaders" | "onRequest" | "onResponse"
      >;
    }>;
  }
> = true;
void checkHooksStages;

/** secrets.list 精确形状（hooks-lifecycle 5.2：{secrets, count}；bearerPrefix 退役）。 */
type SecretsListOutput = Awaited<ReturnType<Client["provider"]["secrets"]["list"]>>;
const checkSecretsList: AssertEqual<
  SecretsListOutput,
  { secrets: Array<{ name: string; createdAt?: number | undefined; updatedAt?: number | undefined }>; count: number }
> = true;
void checkSecretsList;

/** services.test 输入的 auth 槽草稿（hooks-lifecycle 5.2：secretName 单字段退役）。 */
type ServicesTestInput = Parameters<Client["provider"]["services"]["test"]>[0];
const checkServicesTestAuth: AssertEqual<
  ServicesTestInput["auth"],
  | ({ secret: string; bearer?: boolean | undefined })
  | ({ script: string; args?: Record<string, string> | undefined; bearer?: boolean | undefined })
  | ({ literal: string; bearer?: boolean | undefined })
  | undefined
> = true;
void checkServicesTestAuth;

/** writers.preview 的输入参数类型（serviceId/port 二选一联合）。 */
type WritersPreviewInput = Parameters<Client["writers"]["preview"]>[0];
const checkWritersInput: AssertEqual<
  WritersPreviewInput,
  {
    agent: "codex" | "claude-code" | "cursor" | "cline" | "continue";
    target: { serviceId?: string | undefined; port?: number | undefined };
  }
> = true;
void checkWritersInput;

// ---------------------------------------------------------------------------
// 输出形状（返回类型精确到字段）
// ---------------------------------------------------------------------------

/** notifyChannels 输出（字面量路径）。 */
type NotifyChannelsOutput = Awaited<ReturnType<Client["system"]["notifyChannels"]>>;
const checkChannels: AssertEqual<
  NotifyChannelsOutput,
  { rpcPath: "/ws/rpc"; notifyPath: "/ws/notify" }
> = true;
void checkChannels;

/** keys.list 输出不含哈希（Owner 2026-09-13 #5：视图含 name/key 原文，
 *  随时可复制；旧记录两字段缺省）。 */
type KeysListOutput = Awaited<ReturnType<Client["provider"]["keys"]["list"]>>;
const checkKeys: AssertEqual<
  KeysListOutput,
  {
    keys: Array<{
      keyId: string;
      group: string;
      createdAt: number;
      revokedAt?: number | undefined;
      name?: string | undefined;
      key?: string | undefined;
    }>;
  }
> = true;
void checkKeys;

/** consumer.status 输出的状态枚举覆盖 stopped + M1 六态。 */
type ConsumerStatus = Awaited<ReturnType<Client["consumer"]["status"]>>;
const checkStates: AssertEqual<
  ConsumerStatus["providers"][number]["state"],
  | "stopped"
  | "not-connected"
  | "connected-unauthed"
  | "direct"
  | "relay"
  | "offline"
  | "key-all-invalid"
> = true;
void checkStates;

it("contract client type assertions compile", () => {
  // 运行时恒真：本文件的价值在编译期（tsc --noEmit）
  expect(true).toBe(true);
});
