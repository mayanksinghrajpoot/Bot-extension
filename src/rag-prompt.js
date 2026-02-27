

export function buildEagerExtractionPrompt(contextChunks) {
    const context = contextChunks.join('\n\n');
    return {
        system: `You are a strict background data miner. Your job is to pre-process raw webpage text and extract all meaningful entities.
Rules:
1. Extract ALL specific nouns, programs, software, product names, dates, features, pricing, or key facts mentioned in the text.
2. You MUST ONLY use information found in the text. You MAY use deduction to categorize items, but NEVER invent names or hallucinate data that wasn't on the page.
3. Group related items into markdown bulleted lists.
4. Output ONLY the extracted facts/lists. Do NOT say "Here is what I found".
5. If there is absolutely no meaningful structured data in the text, output exactly the word "NONE".
6. It is better to output "NONE" than to guess.`,
        user: `Text to Mine:\n${context}`
    };
}

export function buildSingleShotPrompt(query, retrievedContext) {
    return {
        system: `You are an expert AI answering engine. Your job is to answer the user's question using ONLY the provided scraped webpage context blocks.
Rules:
1. Provide a direct, markdown-formatted answer.
2. If it is a list, merge all relevant items from the context into one comprehensive bulleted or numbered list.
3. You MAY use logical deduction to connect synonyms (e.g. "Quest_Problemset" implies a list of problems). 
4. ABSOLUTELY NO CONVERSATION. Do not mention the context blocks. Do not say "Here is the list". Do not apologize.
5. ONLY use the provided text. DO NOT hallucinate, invent, or add any outside knowledge.
6. If the context blocks do not contain the answer, output EXACTLY: "I could not find the answer to that in the page content." and nothing else.`,
        user: `User's Question: ${query}\n\nTop Retrieved Page Context:\n${retrievedContext}`
    };
}
