import type Anthropic from "@anthropic-ai/sdk";

export interface ForcedTool {
  name: string;
  description: string;
  // JSON Schema for the tool input object (its "properties"/"required").
  schema: Record<string, unknown>;
}

// A forced tool call makes the model answer with a JSON object for a declared
// schema instead of free text, so a correct decision cannot be lost to
// formatting ("None.", "**0**", a sentence of explanation). Callers still
// validate every returned value; this only removes prose from the channel.
export async function forcedToolInput(
  client: Pick<Anthropic, "messages">,
  params: { model: string; maxTokens: number; prompt: string; tool: ForcedTool }
): Promise<Record<string, unknown>> {
  const { tool } = params;
  const message = await client.messages.create({
    model: params.model,
    max_tokens: params.maxTokens,
    tools: [{ name: tool.name, description: tool.description, input_schema: { type: "object", ...tool.schema } }],
    tool_choice: { type: "tool", name: tool.name },
    messages: [{ role: "user", content: params.prompt }],
  });
  if (message.stop_reason === "max_tokens") throw new Error(`${tool.name} response exceeded the output limit`);
  const block = message.content.find((part) => part.type === "tool_use" && part.name === tool.name);
  const input = block?.type === "tool_use" ? block.input : undefined;
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`Model did not return a ${tool.name} tool call`);
  }
  return input as Record<string, unknown>;
}
