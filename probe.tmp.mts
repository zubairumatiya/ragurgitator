try {
  await import("/Users/zube/coding/projects/RAG/lib/db.ts");
  console.log("imported OK");
} catch (e) {
  console.log("THROWS AT IMPORT:", (e as Error).message.slice(0, 120));
}
