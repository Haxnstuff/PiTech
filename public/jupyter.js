// PiTech by Haxnstuff
'use strict';
// PiTech Jupyter panel editor helpers: lightweight syntax highlighting for
// notebook cells. Loaded in the browser as a global; also require()-able for
// node --test (see tests/jupyter.test.cjs).

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PiTechJupyter = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const LANGS = {
    python: {
      label: 'Python',
      re: /(#[^\n]*)|("""[\s\S]*?"""|'''[\s\S]*?'''|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')|\b(def|class|if|elif|else|for|while|return|import|from|as|with|try|except|finally|raise|lambda|pass|break|continue|and|or|not|in|is|None|True|False|global|nonlocal|assert|yield|async|await|del)\b|\b(\d+(?:\.\d+)?)\b|\b(abs|all|any|bool|dict|dir|enumerate|filter|float|format|getattr|hasattr|input|int|isinstance|len|list|map|max|min|open|print|range|repr|reversed|round|set|sorted|str|sum|super|tuple|type|zip)\b/g,
      cls: ['jtk-comment', 'jtk-string', 'jtk-keyword', 'jtk-number', 'jtk-fn'],
    },
    javascript: {
      label: 'JavaScript',
      re: /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)|\b(const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|class|extends|import|export|from|default|async|await|yield|try|catch|finally|throw|typeof|instanceof|delete|in|of|null|undefined|true|false|this|static|get|set)\b|\b(\d+(?:\.\d+)?)\b|\b(console|Math|JSON|Object|Array|String|Number|Boolean|Promise|Map|Set)\b/g,
      cls: ['jtk-comment', 'jtk-string', 'jtk-keyword', 'jtk-number', 'jtk-fn'],
    },
    nodejs: {
      label: 'NodeJS',
      re: /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)|\b(const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|class|extends|import|export|from|default|async|await|yield|try|catch|finally|throw|typeof|instanceof|delete|in|of|null|undefined|true|false|this|static|get|set)\b|\b(\d+(?:\.\d+)?)\b|\b(require|module|exports|process|Buffer|global|console|fs|path|os|http|https|url|stream|events|util)\b/g,
      cls: ['jtk-comment', 'jtk-string', 'jtk-keyword', 'jtk-number', 'jtk-fn'],
    },
    html: {
      label: 'HTML',
      re: /(<!--[\s\S]*?-->)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')|(<\/?[a-zA-Z][a-zA-Z0-9-]*|\/?>)|\b(&[a-zA-Z]+;|<!DOCTYPE|<!doctype)\b|\b(\d+)\b/g,
      cls: ['jtk-comment', 'jtk-string', 'jtk-keyword', 'jtk-fn', 'jtk-number'],
    },
    css: {
      label: 'CSS',
      re: /(\/\*[\s\S]*?\*\/)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')|(@[a-zA-Z-]+|\b[a-zA-Z-]+(?=\s*:))|(#[0-9a-fA-F]{3,8}\b|\b\d+(?:\.\d+)?(?:px|em|rem|vh|vw|%|s|ms|deg|fr)?\b)|\b[a-zA-Z-]+(?=\()/g,
      cls: ['jtk-comment', 'jtk-string', 'jtk-keyword', 'jtk-number', 'jtk-fn'],
    },
    java: {
      label: 'Java',
      re: /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')|\b(abstract|assert|boolean|break|byte|case|catch|char|class|const|continue|default|do|double|else|enum|extends|final|finally|float|for|goto|if|implements|import|instanceof|int|interface|long|native|new|package|private|protected|public|record|return|short|static|strictfp|super|switch|synchronized|this|throw|throws|transient|try|var|void|volatile|while|true|false|null)\b|\b(\d+(?:\.\d+)?[fFdDlL]?)\b|\b(System|String|Math|Integer|Double|Boolean|Object|List|Map|ArrayList|HashMap|Scanner|Exception|Thread)\b/g,
      cls: ['jtk-comment', 'jtk-string', 'jtk-keyword', 'jtk-number', 'jtk-fn'],
    },
    c: {
      label: 'C',
      re: /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')|\b(auto|break|case|char|const|continue|default|do|double|else|enum|extern|float|for|goto|if|inline|int|long|register|restrict|return|short|signed|sizeof|static|struct|switch|typedef|union|unsigned|void|volatile|while)\b|\b(\d+(?:\.\d+)?[fFlLuU]?)\b|\b(printf|scanf|fprintf|sprintf|snprintf|malloc|calloc|realloc|free|memcpy|memset|strlen|strcpy|strcmp|fopen|fclose|main)\b/g,
      cls: ['jtk-comment', 'jtk-string', 'jtk-keyword', 'jtk-number', 'jtk-fn'],
    },
    cpp: {
      label: 'C++',
      re: /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')|\b(alignas|alignof|auto|bool|break|case|catch|char|class|const|constexpr|continue|decltype|default|delete|do|double|else|enum|explicit|export|extern|false|float|for|friend|goto|if|inline|int|long|mutable|namespace|new|noexcept|nullptr|operator|override|private|protected|public|return|short|signed|sizeof|static|struct|switch|template|this|throw|true|try|typedef|typename|union|unsigned|using|virtual|void|volatile|while)\b|\b(\d+(?:\.\d+)?[fFlLuU]?)\b|\b(std|cin|cout|cerr|endl|vector|string|map|set|pair|unique_ptr|shared_ptr|make_shared|make_unique)\b/g,
      cls: ['jtk-comment', 'jtk-string', 'jtk-keyword', 'jtk-number', 'jtk-fn'],
    },
    csharp: {
      label: 'C#',
      re: /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')|\b(abstract|as|async|await|base|bool|break|byte|case|catch|char|checked|class|const|continue|decimal|default|delegate|do|double|else|enum|event|explicit|extern|false|finally|fixed|float|for|foreach|goto|if|implicit|in|int|interface|internal|is|lock|long|namespace|new|null|object|operator|out|override|params|private|protected|public|readonly|record|ref|return|sbyte|sealed|short|sizeof|stackalloc|static|string|struct|switch|this|throw|true|try|typeof|uint|ulong|unchecked|unsafe|ushort|using|var|virtual|void|volatile|while)\b|\b(\d+(?:\.\d+)?[fFdDmMuUlL]?)\b|\b(Console|Math|String|Convert|List|Dictionary|Task|Exception|DateTime|Random)\b/g,
      cls: ['jtk-comment', 'jtk-string', 'jtk-keyword', 'jtk-number', 'jtk-fn'],
    },
    lua: {
      label: 'Lua',
      re: /(--\[\[[\s\S]*?\]\]|--[^\n]*)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')|\b(and|break|do|else|elseif|end|false|for|function|goto|if|in|local|nil|not|or|repeat|return|then|true|until|while)\b|\b(\d+(?:\.\d+)?)\b|\b(print|pairs|ipairs|type|require|tostring|tonumber|pcall|error|assert|select|next|setmetatable|getmetatable|rawget|rawset|table|string|math|io|os)\b/g,
      cls: ['jtk-comment', 'jtk-string', 'jtk-keyword', 'jtk-number', 'jtk-fn'],
    },
    luau: {
      label: 'LuaU',
      re: /(--\[\[[\s\S]*?\]\]|--[^\n]*)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')|\b(and|break|continue|do|else|elseif|end|export|false|for|function|if|in|local|nil|not|or|repeat|return|then|true|until|while|type)\b|\b(\d+(?:\.\d+)?)\b|\b(print|warn|error|assert|pcall|typeof|pairs|ipairs|game|workspace|script|self|Instance|Vector2|Vector3|CFrame|Color3|Enum|task|wait|table|string|math)\b/g,
      cls: ['jtk-comment', 'jtk-string', 'jtk-keyword', 'jtk-number', 'jtk-fn'],
    },
    shell: {
      label: 'Shell',
      re: /(#[^\n]*)|("(?:[^"\\\n]|\\.)*"|'[^']*')|\b(if|then|else|elif|fi|for|while|do|done|case|esac|function|return|export|local|source|alias|echo|cd|ls|rm|mv|cp|mkdir|cat|grep|sed|awk|find|chmod|sudo|pip|python|node|npm|git)\b|\b(\d+)\b/g,
      cls: ['jtk-comment', 'jtk-string', 'jtk-keyword', 'jtk-number'],
    },
    r: {
      label: 'R',
      re: /(#[^\n]*)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')|\b(if|else|for|while|repeat|break|next|return|function|TRUE|FALSE|NULL|NA|Inf|NaN|library|require|install\.packages)\b|\b(\d+(?:\.\d+)?)\b|\b(c|data\.frame|matrix|mean|median|sum|length|print|plot|read\.csv|write\.csv|head|tail|str)\b/g,
      cls: ['jtk-comment', 'jtk-string', 'jtk-keyword', 'jtk-number', 'jtk-fn'],
    },
  };

  function escHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // Turn code into highlighted HTML. Unknown code falls back to escaped plain text.
  function highlight(code, lang) {
    const def = LANGS[lang] || LANGS.python;
    const text = String(code == null ? '' : code);
    if (!text) return '';
    let out = '';
    let last = 0;
    def.re.lastIndex = 0;
    let m;
    while ((m = def.re.exec(text))) {
      out += escHtml(text.slice(last, m.index));
      for (let i = 1; i < m.length; i++) {
        if (m[i] !== undefined) {
          out += `<span class="${def.cls[i - 1]}">${escHtml(m[i])}</span>`;
          break;
        }
      }
      last = m.index + m[0].length;
      if (m[0].length === 0) def.re.lastIndex++; // safety against zero-width matches
    }
    out += escHtml(text.slice(last));
    return out;
  }

  function languages() {
    return Object.entries(LANGS).map(([id, def]) => ({ id, label: def.label }));
  }

  function defaultLanguage() {
    return 'python';
  }

  function isValidLanguage(lang) {
    return Object.prototype.hasOwnProperty.call(LANGS, lang);
  }

  return { highlight, languages, defaultLanguage, isValidLanguage };
});