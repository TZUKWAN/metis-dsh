import io

BS = chr(92)
p = 'electron/CoverLetterService.ts'
s = io.open(p, encoding='utf-8').read()
NL_SRC = BS + BS + 'n'  # 源码里的 \n 字面

old = "const skillPrompt = [" + chr(10) + "      ...(coverLetterBehavior ? coverLetterBehavior.split('" + NL_SRC + "').filter((line) => line.trim().length > 0) : ["
assert old in s, 'coverletter anchor'
new = ("const skillPrompt = [" + chr(10)
       + "      ...(globalStylePrompt.trim() ? [`【内容规范·全局风格（本 Profile 全部动作共同遵守）】" + BS + "n${globalStylePrompt.trim()}`.split('" + NL_SRC + "')] : [])," + chr(10)
       + "      ...(coverLetterBehavior ? coverLetterBehavior.split('" + NL_SRC + "').filter((line) => line.trim().length > 0) : [")
s = s.replace(old, new, 1)
io.open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('coverletter injected')

# image：globalStyle 拼进 prompt（charterPrompt 已存在——同位置追加）
p = 'electron/OutcomeImageService.ts'
s = io.open(p, encoding='utf-8').read()
old_img = "    const prompt = charterPrompt ? `${charterPrompt}" + BS + "n" + BS + "n${userPrompt}` : userPrompt;"
assert old_img in s, 'image prompt anchor'
new_img = ("    const stylePrompt = globalStylePrompt ? `${globalStylePrompt}" + BS + "n" + BS + "n` : '';" + chr(10)
           + "    const prompt = charterPrompt" + chr(10)
           + "      ? `${charterPrompt}" + BS + "n" + BS + "n${stylePrompt}${userPrompt}`" + chr(10)
           + "      : `${stylePrompt}${userPrompt}`;")
s = s.replace(old_img, new_img, 1)
io.open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('image injected')
