$ErrorActionPreference = 'Stop'
Write-Output "`tPS_BACKTICK`nNEXT_LINE"
Write-Output '%h`t%ad`t%an`t%s'
@'
const af = 'a.ts', ai = 7, f = 'b.ts', bj = 8, len = 9;
const regex = /\r?\n/;
console.log(JSON.stringify({
  id: `${af}:${ai}|${f}:${bj}|${len}`,
  path: String.raw`C:\work\new\file.txt`,
  matched: regex.test('first\nsecond'),
  literal: '${notDefined}',
  fence: '```bash',
}));
'@ | node
exit $LASTEXITCODE
