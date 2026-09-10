// RFC 6570 URI Template 子集扩展器（M3-r7：pattern 模式路由的 upstream 路径
// 拼装）。变量值全部来自 URLPattern 捕获组与请求查询参数（字符串）。
// 实现范围：Level 1-2 —— 操作符 ''（pct-encode）、'+'（保留字符）、'/'、'.'、
// ';'、'?'、'&'、'#'；多变量列表；explode '*' 与 prefix ':n' 修饰符解析后按
// 单值语义处理（变量均为字符串）。未定义/空值变量按规范省略。
// 正交意图：纯函数、零依赖、零 IO；不合法模板在 parse 阶段抛
// UriTemplateError（store 写入期 fail-fast）。

export class UriTemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UriTemplateError";
  }
}

/** RFC 6570 操作符表（first: 输出首连接符， sep: 变量间分隔, named: 键值式）。 */
interface OperatorSpec {
  first: string;
  sep: string;
  named: boolean;
  ifemp: string;
  allowReserved: boolean;
}

const OPERATORS: Record<string, OperatorSpec> = {
  "": { first: "", sep: ",", named: false, ifemp: "", allowReserved: false },
  "+": { first: "", sep: ",", named: false, ifemp: "", allowReserved: true },
  ".": { first: ".", sep: ".", named: false, ifemp: "", allowReserved: false },
  "/": { first: "/", sep: "/", named: false, ifemp: "", allowReserved: false },
  ";": { first: ";", sep: ";", named: true, ifemp: "", allowReserved: false },
  "?": { first: "?", sep: "&", named: true, ifemp: "=", allowReserved: false },
  "&": { first: "&", sep: "&", named: true, ifemp: "=", allowReserved: false },
  "#": { first: "#", sep: ",", named: false, ifemp: "", allowReserved: true },
};

const UNRESERVED = /[A-Za-z0-9\-._~]/;
const RESERVED = /[A-Za-z0-9\-._~:\/\?#\[\]@!\$&'()*+,;=]/;

function encodeValue(value: string, allowReserved: boolean): string {
  let out = "";
  for (const ch of value) {
    if (UNRESERVED.test(ch) || (allowReserved && RESERVED.test(ch))) out += ch;
    else {
      for (const byte of new TextEncoder().encode(ch)) out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }
  return out;
}

/** 表达式解析：{op? varspec(,varspec)*}；varspec = name[:n][*]。 */
interface VarSpec {
  name: string;
}

function parseExpression(expr: string): { op: OperatorSpec; vars: VarSpec[] } {
  const opKey = /^[.+\/;?&#]/.test(expr) ? expr[0]! : "";
  const body = expr.slice(opKey.length);
  const spec = OPERATORS[opKey]!;
  const vars: VarSpec[] = [];
  for (const raw of body.split(",")) {
    // 剥掉 prefix (:n) 与 explode (*) 修饰符（单值变量按无修饰语义处理）
    const name = raw.replace(/:\d+$/, "").replace(/\*$/, "").trim();
    if (name === "" || !/^[A-Za-z0-9_.%]+$/.test(name)) {
      throw new UriTemplateError(`invalid variable name '${raw}' in expression '{${expr}}'`);
    }
    vars.push({ name });
  }
  if (vars.length === 0) throw new UriTemplateError(`empty expression '{${expr}}'`);
  return { op: spec, vars };
}

/** 校验模板（写入期 fail-fast 用）：花括号配对 + 全部表达式可解析。 */
export function validateUriTemplate(template: string): void {
  expandUriTemplate(template, {});
}

/** RFC 6570 子集扩展。 */
export function expandUriTemplate(template: string, vars: Record<string, string | undefined>): string {
  let out = "";
  let i = 0;
  while (i < template.length) {
    const open = template.indexOf("{", i);
    if (open < 0) {
      out += template.slice(i);
      break;
    }
    out += template.slice(i, open);
    const close = template.indexOf("}", open);
    if (close < 0) throw new UriTemplateError(`unbalanced '{' in template '${template}'`);
    const { op, vars: specs } = parseExpression(template.slice(open + 1, close));
    const parts: string[] = [];
    let used = false;
    for (const { name } of specs) {
      const raw = vars[name];
      if (raw === undefined || raw === "") continue;
      used = true;
      const value = encodeValue(raw, op.allowReserved);
      parts.push(op.named ? `${name}=${value}` : value);
    }
    if (used) out += op.first + parts.join(op.sep);
    i = close + 1;
  }
  return out;
}
