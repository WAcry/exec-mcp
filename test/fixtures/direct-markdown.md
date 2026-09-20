# 原文回归

Inline: `review`、`main`、`${name}`，以及字面量 \uXXXX。

```bash
printf '%s\n' "${HOME}"
```

```js
const af = "a.ts",
  ai = 7;
const id = `${af}:${ai}`;
// Backslashes, comments and nested templates remain file content.
const pattern = /Sig\[\d+\]/;
const path = String.raw`C:\work\new\file.txt`;
```

```powershell
Write-Output "`tname`nnext"
@'
console.log(`literal ${value}`);
'@ | node
```

    保留四个空格和 \n 的字面形式。
