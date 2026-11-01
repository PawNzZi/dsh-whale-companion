/**
 * 流式回复的正文提取。
 *
 * 模型输出约定为：
 *   正文（自然语言，可以多行）
 *   [[meta]]{"emotion":"happy","action":"nod",...}
 *
 * 同时兼容旧版整段 JSON（{"text":...}）：如果输出以 `{` 开头，就按 JSON
 * 字符串状态机增量解出 text 字段，避免把 JSON 直接打到聊天界面。
 *
 * 所有模式都只在确认字符属于正文后才吐出，标记/转义序列被拆在两个 chunk
 * 里也能正确处理。
 */
export const META_MARKER = '[[meta]]';

function cleanBody(text) {
  let value = text.trim();
  const fenced = value.match(/^```(?:json)?\s*([\s\S]*?)```$/i);
  if (fenced) {
    value = fenced[1].trim();
  }
  return value;
}

/**
 * 从完整模型输出里拆出正文和元数据 JSON 文本。
 * @param {string} raw
 * @returns {{body: string, metaRaw: string | null}}
 */
export function splitReplyText(raw) {
  const text = typeof raw === 'string' ? raw : '';
  const index = text.indexOf(META_MARKER);
  if (index >= 0) {
    return {
      body: cleanBody(text.slice(0, index)),
      metaRaw: text.slice(index + META_MARKER.length).trim() || null
    };
  }
  return { body: cleanBody(text), metaRaw: null };
}

export class ReplyTextExtractor {
  constructor() {
    this.buffer = '';
    this.mode = 'unknown';
    this.phase = 'find';
    this.done = false;
    this.started = false;
    this.escaped = false;
    this.unicodeDigits = 0;
    this.unicodeValue = 0;
    this.hex = '';
  }

  /** 喂入一个模型文本块，返回本次可以安全发给 App 的正文增量。 */
  push(chunk) {
    if (this.done || typeof chunk !== 'string' || chunk.length === 0) {
      return '';
    }
    this.buffer += chunk;
    const output = [];
    for (;;) {
      if (this.mode === 'unknown') {
        this.buffer = this.buffer.replace(/^\s+/, '');
        if (this.buffer.length === 0) {
          break;
        }
        if (this.buffer.startsWith('```')) {
          const newline = this.buffer.indexOf('\n');
          if (newline < 0) {
            break;
          }
          this.buffer = this.buffer.slice(newline + 1);
          continue;
        }
        this.mode = this.buffer[0] === '{' ? 'json' : 'plain';
        continue;
      }
      if (this.mode === 'plain') {
        const index = this.buffer.indexOf(META_MARKER);
        if (index >= 0) {
          output.push(this.#trimLeading(this.buffer.slice(0, index).replace(/\s+$/, '')));
          this.buffer = '';
          this.done = true;
          break;
        }
        const keep = META_MARKER.length - 1;
        if (this.buffer.length <= keep) {
          break;
        }
        output.push(this.#trimLeading(this.buffer.slice(0, this.buffer.length - keep)));
        this.buffer = this.buffer.slice(this.buffer.length - keep);
        break;
      }
      if (this.mode === 'json') {
        output.push(this.#decodeJson());
        break;
      }
      break;
    }
    return output.join('');
  }

  /** 流结束：没有 meta 标记时，剩余内容就是正文。 */
  finish() {
    if (this.done) {
      return '';
    }
    this.done = true;
    if (this.mode === 'json' && this.phase === 'string') {
      const tail = this.#decodeJson();
      return tail;
    }
    const output = this.#trimLeading(this.buffer).replace(/\s+$/, '');
    this.buffer = '';
    return output;
  }

  #trimLeading(value) {
    if (this.started || value.length === 0) {
      return value;
    }
    const trimmed = value.replace(/^\s+/, '');
    if (trimmed.length > 0) {
      this.started = true;
    }
    return trimmed;
  }

  /** 增量解析 {"text":"..."}，只返回 text 的已解码内容。 */
  #decodeJson() {
    let output = '';
    if (this.phase === 'find') {
      const match = /"text"\s*:\s*"/.exec(this.buffer);
      if (match === null) {
        if (this.buffer.length > 4096) {
          this.mode = 'plain';
          return '';
        }
        return '';
      }
      this.buffer = this.buffer.slice(match.index + match[0].length);
      this.phase = 'string';
    }
    if (this.phase !== 'string') {
      return '';
    }
    let index = 0;
    while (index < this.buffer.length) {
      const char = this.buffer[index];
      if (this.unicodeDigits > 0) {
        if (!/[0-9a-fA-F]/.test(char)) {
          // 非法 unicode 转义：按字面量回退
          output += `\\u${this.hex}`;
          this.unicodeDigits = 0;
          this.hex = '';
          continue;
        }
        this.unicodeValue = this.unicodeValue * 16 + Number.parseInt(char, 16);
        this.hex += char;
        this.unicodeDigits -= 1;
        index += 1;
        if (this.unicodeDigits === 0) {
          output += String.fromCharCode(this.unicodeValue);
          this.unicodeValue = 0;
          this.hex = '';
        }
        continue;
      }
      if (this.escaped) {
        this.escaped = false;
        if (char === 'u') {
          this.unicodeDigits = 4;
          this.unicodeValue = 0;
          this.hex = '';
          index += 1;
          continue;
        }
        const map = {
          '"': '"',
          '\\': '\\',
          '/': '/',
          b: '\b',
          f: '\f',
          n: '\n',
          r: '\r',
          t: '\t'
        };
        output += map[char] ?? char;
        index += 1;
        continue;
      }
      if (char === '\\') {
        this.escaped = true;
        index += 1;
        continue;
      }
      if (char === '"') {
        index += 1;
        this.phase = 'done';
        this.done = true;
        break;
      }
      output += char;
      index += 1;
    }
    this.buffer = this.buffer.slice(index);
    return this.#trimLeading(output);
  }
}
