# Repair mangled regex line + dangling fragment in artifact/index.ts.

path = 'plugins/artifact/src/index.ts'
with open(path, encoding='utf-8', newline='') as f:
    src = f.read()

bs = chr(92)
good_split = ".split(/" + bs + "r?" + bs + "n/)"

lines = src.split(chr(10))
out = []
skip_until_brace = False
for idx, line in enumerate(lines):
    if skip_until_brace:
        if line.strip() == '}':
            skip_until_brace = False
            out.append(line)
        continue
    if ".split(" in line and "utf8" in line and good_split not in line:
        out.append("          return readFileSync(file.absolutePath, 'utf8')" + good_split)
        # swallow stray continuation fragments until the closing '        }' line
        skip_until_brace = True
        continue
    out.append(line)
src = chr(10).join(out)

# dangling configuredStatus fragment cleanup
frag = "(value: string | undefined): ArtifactStatus | undefined {" + chr(10) + "  return value === 'draft' || value === 'review' || value === 'final' ? value : undefined" + chr(10) + "}"
if frag in src:
    src = src.replace(frag, "")
# remove any dangling 'function configuredStat' partial
if chr(10) + "function configuredStat" in src and "function configuredStatus" not in src:
    start = src.index(chr(10) + "function configuredStat")
    end = src.index(chr(10) + "}" + chr(10), start) + len(chr(10)) 
    src = src[:start] + src[end + 1:]

with open(path, 'w', encoding='utf-8', newline=chr(10)) as f:
    f.write(src)
print('repaired')
