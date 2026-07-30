export type OptionDefinition =
  | { readonly type: "boolean" }
  | { readonly type: "string" };

export interface ParsedArguments {
  readonly positionals: readonly string[];
  readonly options: Readonly<Record<string, string | boolean>>;
}

export class UsageError extends Error {
  readonly exitCode = 2;

  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export function parseArguments(
  args: readonly string[],
  definitions: Readonly<Record<string, OptionDefinition>>,
): ParsedArguments {
  const positionals: string[] = [];
  const options: Record<string, string | boolean> = {};
  let positionalOnly = false;

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (positionalOnly || token === "-" || !token.startsWith("-")) {
      positionals.push(token);
      continue;
    }
    if (token === "--") {
      positionalOnly = true;
      continue;
    }
    if (!token.startsWith("--")) {
      throw new UsageError(`Unsupported short option: ${token}`);
    }

    const equalsIndex = token.indexOf("=");
    const name =
      equalsIndex >= 0 ? token.slice(2, equalsIndex) : token.slice(2);
    const inlineValue =
      equalsIndex >= 0 ? token.slice(equalsIndex + 1) : undefined;
    const definition = definitions[name];
    if (!definition) throw new UsageError(`Unknown option: --${name}`);
    if (Object.hasOwn(options, name)) {
      throw new UsageError(`Option may be supplied only once: --${name}`);
    }

    if (definition.type === "boolean") {
      if (inlineValue !== undefined) {
        throw new UsageError(`Boolean option takes no value: --${name}`);
      }
      options[name] = true;
      continue;
    }

    const value = inlineValue ?? args[++index];
    if (value === undefined || (inlineValue === undefined && value.startsWith("--"))) {
      throw new UsageError(`Option requires a value: --${name}`);
    }
    options[name] = value;
  }

  return { positionals, options };
}

export function stringOption(
  parsed: ParsedArguments,
  name: string,
): string | undefined {
  const value = parsed.options[name];
  return typeof value === "string" ? value : undefined;
}

export function booleanOption(
  parsed: ParsedArguments,
  name: string,
): boolean {
  return parsed.options[name] === true;
}

export function integerOption(
  parsed: ParsedArguments,
  name: string,
  fallback?: number,
): number | undefined {
  const value = stringOption(parsed, name);
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) {
    throw new UsageError(`--${name} must be a positive integer.`);
  }
  const parsedValue = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsedValue) || parsedValue <= 0) {
    throw new UsageError(`--${name} must be a positive integer.`);
  }
  return parsedValue;
}

export function requirePositionals(
  parsed: ParsedArguments,
  minimum: number,
  maximum: number,
  usage: string,
): void {
  if (
    parsed.positionals.length < minimum ||
    parsed.positionals.length > maximum
  ) {
    throw new UsageError(`Usage: ${usage}`);
  }
}
