//! Content vectors retained when the retired Node exporter was removed.
use std::{error::Error, fs};

use memokeep_storage::{initialize, publishing, read, write, Fields};
use serde_json::{json, Value};

#[test]
fn legacy_quill_code_and_tables_keep_their_literal_content() -> Result<(), Box<dyn Error>> {
    let code = concat!(
        "<div class=\"ql-code-block-container\">",
        "<div class=\"ql-code-block\" data-language=\"mermaid\">flowchart TD</div>",
        "<div class=\"ql-code-block\" data-language=\"mermaid\">  A --&gt; B</div>",
        "<div class=\"ql-code-block\" data-language=\"mermaid\"><br></div>",
        "<div class=\"ql-code-block\" data-language=\"mermaid\">  B --&gt; C</div></div>"
    );
    assert_eq!(
        publishing::rich_markdown(code)?.trim_end(),
        "```mermaid\nflowchart TD\n  A --> B\n\n  B --> C\n```"
    );
    assert_eq!(
        publishing::rich_markdown("<pre data-language=\"js\">  let x = 1;\n```</pre>")?.trim_end(),
        "````js\n  let x = 1;\n```\n````"
    );
    let table = concat!(
        "<table><tbody><tr><td><strong>快捷键</strong></td><td>作用</td></tr>",
        "<tr><td><code>cmd | k</code></td><td>清屏<br>继续</td></tr></tbody></table>"
    );
    assert_eq!(
        publishing::rich_markdown(table)?.trim_end(),
        "| **快捷键** | 作用 |\n| --- | --- |\n| `cmd \\| k` | 清屏  <br>继续 |"
    );
    Ok(())
}

#[test]
fn plain_text_publication_does_not_parse_markup_or_old_editor_caches() -> Result<(), Box<dyn Error>>
{
    let directory = tempfile::tempdir()?;
    let database = directory.path().join("workspace.sqlite");
    let output = directory.path().join("published");
    initialize(&database)?;
    let literal = "# 保持原文\r\n\r\n  **字面文本**\t中文😀\r\n<img src=\"example\">\r\nmemokeep-image://11111111-2222-3333-4444-555555555555";
    let data: Fields = serde_json::from_value(json!({
        "knowledgeBases": [{"id":"library","name":"合成数据"}],
        "documents":[{"id":"plain-note","knowledgeBaseId":"library","title":"原文",
            "sourceType":"manual-text","content":literal,
            "metadata":{"fileType":"txt","editorMode":"note","noteContentInitialized":true,
                "noteContent":"<p>不能导出这段旧缓存</p>"}}],
        "cards":[]
    }))?;
    write(&database, "desktop", 0, &data)?;
    publishing::configure(&database, &output)?;
    assert!(publishing::publish(&database)?.warnings.is_empty());
    let manifest: Value = serde_json::from_slice(&fs::read(output.join(".memokeep-sync.json"))?)?;
    let file = manifest["files"]
        .as_array()
        .and_then(|files| files.first())
        .and_then(Value::as_str)
        .ok_or("missing published note")?;
    assert!(file.ends_with(".txt"));
    assert_eq!(fs::read_to_string(output.join(file))?, literal);
    assert_eq!(read(&database, "desktop")?.data, data);
    Ok(())
}
