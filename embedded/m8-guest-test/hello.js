// M8 guest exec matrix — node probe (embedded/EXEC-DESIGN.md §9.2).
// Reaching this line means: guest bash exec'd node (ELF), whose PT_INTERP
// ld-linux and libs were mapped by proot's loader — the full §3 chain.
console.log("node OK (" + process.version + ")");
