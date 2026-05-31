type JsonRecord = Record<string, unknown>;

export type ClaudeToolCall = {
  id: string;
  name: string;
  input: JsonRecord;
};

export const KIRO_TO_CLAUDE_TOOL_NAMES: Record<string, string> = {
  glob: "Glob",
  grep: "Grep",
  read: "Read",
  shell: "PowerShell",
  web_fetch: "WebFetch",
  web_search: "WebSearch",
  write: "Write",
};

export const CLAUDE_TO_KIRO_TOOL_NAMES: Record<string, string> = {
  Bash: "shell",
  Glob: "glob",
  Grep: "grep",
  PowerShell: "shell",
  Read: "read",
  Shell: "shell",
  WebFetch: "web_fetch",
  WebSearch: "web_search",
  Write: "write",
};

export const KIRO_CLAUDE_EXECUTABLE_TOOL_NAMES = [
  "glob",
  "grep",
  "read",
  "shell",
  "web_fetch",
  "web_search",
  "write",
] as const;

export const KIRO_NATIVE_TOOL_NAMES = [
  "code",
  "glob",
  "grep",
  "introspect",
  "knowledge",
  "read",
  "shell",
  "subagent",
  "todo_list",
  "use_aws",
  "web_fetch",
  "web_search",
  "write",
] as const;

const KIRO_TOOL_SCHEMAS: Record<string, JsonRecord> = {
  code: {
    type: "object",
    required: ["operation"],
    properties: {
      operation: {
        type: "string",
        enum: [
          "search_symbols",
          "lookup_symbols",
          "get_document_symbols",
          "pattern_search",
          "pattern_rewrite",
          "generate_codebase_overview",
          "search_codebase_map",
        ],
      },
      path: { type: "string" },
      file_path: { type: "string" },
      symbol_name: { type: "string" },
      pattern: { type: "string" },
      language: { type: "string" },
      replacement: { type: "string" },
      limit: { type: "integer" },
      include_source: { type: "boolean" },
      __tool_use_purpose: { type: "string" },
    },
  },
  glob: {
    type: "object",
    required: ["pattern"],
    properties: {
      pattern: { type: "string" },
      path: { type: "string" },
      __tool_use_purpose: { type: "string" },
    },
  },
  grep: {
    type: "object",
    required: ["pattern"],
    properties: {
      pattern: { type: "string" },
      path: { type: "string" },
      include: { type: "string" },
      output_mode: { type: "string" },
      case_sensitive: { type: "boolean" },
      max_files: { type: "integer" },
      max_matches_per_file: { type: "integer" },
      max_total_lines: { type: "integer" },
      __tool_use_purpose: { type: "string" },
    },
  },
  introspect: {
    type: "object",
    required: [],
    properties: {
      query: { type: "string" },
      doc_path: { type: "string" },
      __tool_use_purpose: { type: "string" },
    },
  },
  knowledge: {
    type: "object",
    required: ["command"],
    properties: {
      command: {
        type: "string",
        enum: ["show", "add", "remove", "clear", "search", "update", "status", "cancel"],
      },
      query: { type: "string" },
      name: { type: "string" },
      value: { type: "string" },
      path: { type: "string" },
      context_id: { type: "string" },
      limit: { type: "integer" },
      offset: { type: "integer" },
      snippet_length: { type: "integer" },
      __tool_use_purpose: { type: "string" },
    },
  },
  read: {
    type: "object",
    required: ["operations"],
    properties: {
      operations: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          properties: {
            path: { type: "string" },
            mode: { type: "string", enum: ["Line", "Directory", "Image"] },
            limit: { type: "integer" },
            offset: { type: "integer" },
            depth: { type: "integer" },
            image_paths: { type: "array", items: { type: "string" } },
          },
        },
      },
      __tool_use_purpose: { type: "string" },
    },
  },
  shell: {
    type: "object",
    required: ["command"],
    properties: {
      command: { type: "string" },
      timeout_ms: { type: "integer" },
      __tool_use_purpose: { type: "string" },
    },
  },
  subagent: {
    type: "object",
    required: ["task", "stages"],
    properties: {
      task: { type: "string" },
      mode: { type: "string", enum: ["blocking", "background"] },
      stages: {
        type: "array",
        items: {
          type: "object",
          required: ["name", "role", "prompt_template"],
          properties: {
            name: { type: "string" },
            role: { type: "string", enum: ["kiro_default", "kiro_planner", "kiro_guide"] },
            prompt_template: { type: "string" },
            depends_on: { type: "array", items: { type: "string" } },
          },
        },
      },
      __tool_use_purpose: { type: "string" },
    },
  },
  todo_list: {
    type: "object",
    required: ["command"],
    properties: {
      command: { type: "string", enum: ["create", "add", "complete", "remove"] },
      task_list_description: { type: "string" },
      tasks: {
        type: "array",
        items: {
          type: "object",
          required: ["task_description"],
          properties: {
            task_description: { type: "string" },
            details: { type: "string" },
          },
        },
      },
      new_tasks: {
        type: "array",
        items: {
          type: "object",
          required: ["task_description"],
          properties: {
            task_description: { type: "string" },
            details: { type: "string" },
          },
        },
      },
      completed_task_ids: { type: "array", items: { type: "string" } },
      remove_task_ids: { type: "array", items: { type: "string" } },
      context_update: { type: "string" },
      modified_files: { type: "array", items: { type: "string" } },
      __tool_use_purpose: { type: "string" },
    },
  },
  use_aws: {
    type: "object",
    required: ["region", "service_name", "operation_name", "label"],
    properties: {
      region: { type: "string" },
      service_name: { type: "string" },
      operation_name: { type: "string" },
      label: { type: "string" },
      parameters: { type: "object" },
      positional_args: { type: "array", items: { type: "string" } },
      __tool_use_purpose: { type: "string" },
    },
  },
  web_fetch: {
    type: "object",
    required: ["url"],
    properties: {
      url: { type: "string" },
      prompt: { type: "string" },
      __tool_use_purpose: { type: "string" },
    },
  },
  web_search: {
    type: "object",
    required: ["query"],
    properties: {
      query: { type: "string" },
      allowed_domains: { type: "array", items: { type: "string" } },
      blocked_domains: { type: "array", items: { type: "string" } },
      __tool_use_purpose: { type: "string" },
    },
  },
  write: {
    type: "object",
    required: ["path", "content"],
    properties: {
      path: { type: "string" },
      content: { type: "string" },
      append: { type: "boolean" },
      __tool_use_purpose: { type: "string" },
    },
  },
};

const KIRO_TOOL_DESCRIPTIONS: Record<string, string> = {
  code: "Code intelligence with AST parsing, symbol search, document symbols, structural search, and codebase overview.",
  glob: "Find files and directories whose paths match a glob pattern. Respects .gitignore.",
  grep: "Fast text pattern search in files using regex. Respects .gitignore.",
  introspect: "Retrieve Kiro CLI documentation or answer questions about assistant capabilities.",
  knowledge: "Manage and search persistent knowledge contexts.",
  read: "Read files, directories, and images through one or more read operations.",
  shell: "Execute shell commands in the current workspace.",
  subagent: "Spawn and coordinate multiple AI agents in a dependency pipeline.",
  todo_list: "Create and update a task list for multi-step work.",
  use_aws: "Call AWS services with region, service, operation, label, and parameters.",
  web_fetch: "Fetch and summarize a web page by URL.",
  web_search: "Search the web for current information.",
  write: "Write content to a file path in the workspace.",
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function pickString(source: JsonRecord, key: string): string | undefined {
  const value = source[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function pickNumber(source: JsonRecord, key: string): number | undefined {
  const value = source[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function pickStringArray(source: JsonRecord, key: string): string[] | undefined {
  const value = source[key];
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((item): item is string => typeof item === "string");
  return strings.length > 0 ? strings : undefined;
}

export function normalizeToolNameForKiro(name: unknown): string {
  const raw = String(name || "");
  if (CLAUDE_TO_KIRO_TOOL_NAMES[raw]) return CLAUDE_TO_KIRO_TOOL_NAMES[raw];
  return raw
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[\s-]+/g, "_")
    .toLowerCase();
}

export function isClaudeExecutableKiroTool(name: string): boolean {
  return KIRO_CLAUDE_EXECUTABLE_TOOL_NAMES.includes(
    name as (typeof KIRO_CLAUDE_EXECUTABLE_TOOL_NAMES)[number]
  );
}

export function buildKiroToolSpecsForClaudeCode(): JsonRecord[] {
  return KIRO_NATIVE_TOOL_NAMES.map((name) => ({
    toolSpecification: {
      name,
      description: KIRO_TOOL_DESCRIPTIONS[name] || `Kiro ${name} tool`,
      inputSchema: { json: clone(KIRO_TOOL_SCHEMAS[name]) },
    },
  }));
}

export function parseKiroToolInput(input: unknown): JsonRecord {
  if (typeof input === "string") {
    try {
      return parseKiroToolInput(JSON.parse(input));
    } catch {
      return {};
    }
  }
  if (!isRecord(input)) return {};
  if (isRecord(input.json)) return input.json;
  return input;
}

export function normalizeClaudeToolUseForKiro(toolName: string, input: unknown): JsonRecord {
  const source = parseKiroToolInput(input);

  if (toolName === "read") {
    if (Array.isArray(source.operations) && source.operations.length > 0) return source;
    const path = pickString(source, "file_path") || pickString(source, "path");
    if (!path) return {};
    return {
      operations: [
        {
          path,
          mode: pickString(source, "mode") || "Line",
          ...(pickNumber(source, "offset") !== undefined
            ? { offset: pickNumber(source, "offset") }
            : {}),
          ...(pickNumber(source, "limit") !== undefined
            ? { limit: pickNumber(source, "limit") }
            : {}),
        },
      ],
      ...(pickString(source, "__tool_use_purpose")
        ? { __tool_use_purpose: pickString(source, "__tool_use_purpose") }
        : {}),
    };
  }

  if (toolName === "shell") {
    return {
      ...(pickString(source, "command") ? { command: pickString(source, "command") } : {}),
      ...(pickNumber(source, "timeout") !== undefined
        ? { timeout_ms: pickNumber(source, "timeout") }
        : {}),
      ...(pickNumber(source, "timeout_ms") !== undefined
        ? { timeout_ms: pickNumber(source, "timeout_ms") }
        : {}),
      ...(pickString(source, "description")
        ? { __tool_use_purpose: pickString(source, "description") }
        : {}),
    };
  }

  if (toolName === "write") {
    return {
      ...source,
      ...(pickString(source, "file_path") && !source.path
        ? { path: pickString(source, "file_path") }
        : {}),
    };
  }

  return source;
}

export function normalizeKiroToolUseForClaude(
  toolUseId: string,
  name: string,
  input: unknown
): ClaudeToolCall[] {
  const mappedName = KIRO_TO_CLAUDE_TOOL_NAMES[name] || name;
  const source = parseKiroToolInput(input);

  if (name === "code") {
    const filePath = pickString(source, "file_path");
    if (filePath) {
      return [{ id: toolUseId, name: "Read", input: { file_path: filePath } }];
    }

    const searchPattern = pickString(source, "pattern") || pickString(source, "symbol_name");
    if (searchPattern) {
      return [
        {
          id: toolUseId,
          name: "Grep",
          input: {
            pattern: searchPattern,
            ...(pickString(source, "path") ? { path: pickString(source, "path") } : {}),
          },
        },
      ];
    }

    return [
      {
        id: toolUseId,
        name: "Glob",
        input: {
          pattern: "**/*",
          ...(pickString(source, "path") ? { path: pickString(source, "path") } : {}),
        },
      },
    ];
  }

  if (name === "introspect" || name === "knowledge") {
    const query =
      pickString(source, "query") || pickString(source, "doc_path") || pickString(source, "name");
    return [
      {
        id: toolUseId,
        name: query ? "WebSearch" : "PowerShell",
        input: query
          ? { query }
          : {
              command: `Write-Output ${JSON.stringify(`${name} requested: ${JSON.stringify(source)}`)}`,
            },
      },
    ];
  }

  if (name === "todo_list" || name === "subagent") {
    return [
      {
        id: toolUseId,
        name: "PowerShell",
        input: {
          command: `Write-Output ${JSON.stringify(`${name} acknowledged: ${JSON.stringify(source)}`)}`,
        },
      },
    ];
  }

  if (name === "use_aws") {
    const service = pickString(source, "service_name") || "aws";
    const operation = pickString(source, "operation_name") || "help";
    const region = pickString(source, "region");
    const positionalArgs = Array.isArray(source.positional_args)
      ? source.positional_args.filter((arg): arg is string => typeof arg === "string")
      : [];
    const command = [
      "aws",
      service,
      operation,
      ...(region ? ["--region", region] : []),
      ...positionalArgs,
    ].join(" ");
    return [{ id: toolUseId, name: "PowerShell", input: { command } }];
  }

  if (name === "glob") {
    return [
      {
        id: toolUseId,
        name: mappedName,
        input: {
          ...(pickString(source, "pattern") ? { pattern: pickString(source, "pattern") } : {}),
          ...(pickString(source, "path") ? { path: pickString(source, "path") } : {}),
        },
      },
    ];
  }

  if (name === "grep") {
    const outputMode = pickString(source, "output_mode");
    const validOutputModes = new Set(["content", "files_with_matches", "count"]);
    return [
      {
        id: toolUseId,
        name: mappedName,
        input: {
          ...(pickString(source, "pattern") ? { pattern: pickString(source, "pattern") } : {}),
          ...(pickString(source, "path") ? { path: pickString(source, "path") } : {}),
          ...(pickString(source, "include") ? { glob: pickString(source, "include") } : {}),
          ...(pickString(source, "glob") ? { glob: pickString(source, "glob") } : {}),
          ...(outputMode && validOutputModes.has(outputMode) ? { output_mode: outputMode } : {}),
        },
      },
    ];
  }

  if (name === "read") {
    const operations = Array.isArray(source.operations) ? source.operations : [];
    const calls = operations.filter(isRecord).map((op, index) => {
      if (op.mode === "Directory") {
        return {
          id: operations.length > 1 ? `${toolUseId}_${index}` : toolUseId,
          name: "Glob",
          input: {
            pattern: "*",
            ...(pickString(op, "path") ? { path: pickString(op, "path") } : {}),
          },
        };
      }
      return {
        id: operations.length > 1 ? `${toolUseId}_${index}` : toolUseId,
        name: mappedName,
        input: {
          ...(pickString(op, "path") ? { file_path: pickString(op, "path") } : {}),
          ...(pickNumber(op, "offset") !== undefined ? { offset: pickNumber(op, "offset") } : {}),
          ...(pickNumber(op, "limit") !== undefined ? { limit: pickNumber(op, "limit") } : {}),
        },
      };
    });
    return calls.length > 0 ? calls : [{ id: toolUseId, name: mappedName, input: {} }];
  }

  if (name === "shell") {
    return [
      {
        id: toolUseId,
        name: mappedName,
        input: {
          ...(pickString(source, "command") ? { command: pickString(source, "command") } : {}),
          ...(pickNumber(source, "timeout_ms") !== undefined
            ? { timeout: pickNumber(source, "timeout_ms") }
            : {}),
          ...(pickNumber(source, "timeout") !== undefined
            ? { timeout: pickNumber(source, "timeout") }
            : {}),
          ...(pickString(source, "__tool_use_purpose")
            ? { description: pickString(source, "__tool_use_purpose") }
            : {}),
        },
      },
    ];
  }

  if (name === "web_fetch") {
    return [
      {
        id: toolUseId,
        name: mappedName,
        input: {
          ...(pickString(source, "url") ? { url: pickString(source, "url") } : {}),
          prompt: pickString(source, "prompt") || "Summarize this page.",
        },
      },
    ];
  }

  if (name === "web_search") {
    return [
      {
        id: toolUseId,
        name: mappedName,
        input: {
          ...(pickString(source, "query") ? { query: pickString(source, "query") } : {}),
          ...(pickStringArray(source, "allowed_domains")
            ? { allowed_domains: pickStringArray(source, "allowed_domains") }
            : {}),
          ...(pickStringArray(source, "blocked_domains")
            ? { blocked_domains: pickStringArray(source, "blocked_domains") }
            : {}),
        },
      },
    ];
  }

  if (name === "write") {
    return [
      {
        id: toolUseId,
        name: mappedName,
        input: {
          ...(pickString(source, "path") ? { file_path: pickString(source, "path") } : {}),
          ...(pickString(source, "file_path")
            ? { file_path: pickString(source, "file_path") }
            : {}),
          ...(typeof source.content === "string" ? { content: source.content } : {}),
        },
      },
    ];
  }

  return [{ id: toolUseId, name: mappedName, input: source }];
}

export function shouldKeepToolResultAsText(_toolUseId: string): boolean {
  return true;
}
