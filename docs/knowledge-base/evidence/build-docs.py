"""Generate offline HTML with local Mermaid and pre-rendered PlantUML SVG. Stdlib only."""
from pathlib import Path
import hashlib
import html
import json
import os
import re
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
if not (ROOT/'vendor/mermaid/mermaid.min.js').is_file():
    raise SystemExit('Missing local Mermaid runtime: vendor/mermaid/mermaid.min.js')

FILES = [
 ('README.md','guide','阅读入口'),('01-codebase.md','codebase','01 代码知识地图'),
 ('02-flows-and-development.md','flows','02 流程与开发'),('03-product-improvements.md','product','03 对比与体验清单'),
 ('04-code-audit.md','audit','04 Bug 与代码清单'),('05-windows-architecture.md','architecture','05 Windows 架构'),
 ('06-roadmap.md','roadmap','06 路线与验收'),
 ('07-commit-convention.md','commit-convention','07 代码提交规范'),
 ('08-code-review-2026-10-04.md','commit-review','08 Brraida 提交审查'),
 ('09-review-evidence.md','review-evidence','09 审查验证与复现'),
 ('10-download-file-state.md','download-file-state','10 下载文件状态同步'),
 ('11-vinyl-player-preview.md','vinyl-player-preview','11 唱片播放效果'),
 ('12-jiangnan-porcelain-theme.md','jiangnan-porcelain-theme','12 江南 · 青花主题预览'),
 ('13-jiangnan-theme-implementation.md','jiangnan-theme-implementation','13 青花主题实际预览'),
 ('14-ktv-two-line-lyrics.md','ktv-two-line-lyrics','14 双行歌词样式与方案')]
TARGETS={name: '#'+slug for name,slug,_ in FILES}
CANONICALS={
    '07-commit-convention.md': (ROOT/'../../COMMIT_CONVENTION.md','07 · 代码提交规范'),
    '08-code-review-2026-10-04.md': (ROOT/'../../CODE_REVIEW_2026-10-04.md','08 · Brraida 提交审查（历史基线）'),
    '09-review-evidence.md': (ROOT/'../reviews/2026-10-04/README.md','09 · 历史审查验证与复现'),
}
CHAPTER_PATHS={(ROOT/name).resolve(): '#'+slug for name,slug,_ in FILES}
CHAPTER_PATHS.update({path.resolve():TARGETS[name] for name,(path,_) in CANONICALS.items()})

def read_chapter(name):
    if name not in CANONICALS: return (ROOT/name).read_text(encoding='utf8')
    path,title=CANONICALS[name]
    source=path.read_text(encoding='utf8').split('\n',1)[1]
    def rebase(match):
        target=match[1]
        if re.match(r'^[A-Za-z][\w+.-]*:|^#|^/',target): return match[0]
        relative,separator,fragment=target.partition('#')
        absolute=(path.parent/relative).resolve()
        href=CHAPTER_PATHS.get(absolute)
        if not href: href=os.path.relpath(absolute,ROOT).replace(os.sep,'/')+(separator+fragment if separator else '')
        return ']('+href+')'
    source=re.sub(r'\]\(([^)]+)\)',rebase,source)
    note=('> 历史审查基线：`dev@4e7b711`。本轮下载文件同步已实现并验证，见 [10](10-download-file-state.md)；其他审查项继续按原状态管理。\n\n'
          if name!='07-commit-convention.md' else '')
    return '# '+title+'\n\n[返回目录](README.md)\n\n'+note+source
MANIFEST=ROOT/'assets/plantuml/manifest.json'
PLANTUML={entry['svg']: entry for entry in json.loads(MANIFEST.read_text(encoding='utf8'))} if MANIFEST.is_file() else {}

def plantuml_figure(target,label,identifier):
    entry=PLANTUML[target]
    source=(ROOT/entry['source']).read_text(encoding='utf8')
    svg=(ROOT/target).read_text(encoding='utf8')
    for value,key in ((source,'sourceSha256'),(svg,'svgSha256')):
        if hashlib.sha256(value.encode('utf8')).hexdigest()!=entry[key]:
            raise SystemExit('Stale PlantUML SVG; run evidence/render-plantuml.py again: '+target)
    tree=ET.fromstring(svg)
    if tree.tag!='{http://www.w3.org/2000/svg}svg':
        raise SystemExit('Invalid PlantUML SVG: '+target)
    svg=svg[svg.index('<svg'):svg.rindex('</svg>')+6]
    # PlantUML fixes dimensions in an inline style; let responsive CSS preserve aspect ratio.
    svg=re.sub(r'^<svg[^>]*>',lambda match: re.sub(r'(?:width|height):[\d.]+px;?', '', match[0]),svg,count=1)
    # Each inline SVG has its own IDs, including when all chapters are printed.
    for old in set(re.findall(r'\bid="([^"]+)"',svg)):
        new=identifier+'-'+old
        svg=svg.replace('id="'+old+'"','id="'+new+'"').replace('url(#'+old+')','url(#'+new+')')
        svg=svg.replace('href="#'+old+'"','href="#'+new+'"')
    return (f'<figure class="diagram" id="{identifier}" data-diagram-language="plantuml" data-diagram-state="rendered">'
        f'<div class="diagram-output" role="img" aria-label="{html.escape(label,quote=True)}">{svg}</div>'
        '<p class="diagram-error" role="status" hidden></p>'
        f'<figcaption>{html.escape(label)} · <a href="{target}" target="_blank" rel="noopener">打开大图</a></figcaption>'
        '<details class="diagram-source"><summary>查看 PlantUML 源码</summary><pre><code class="language-plantuml">'
        +html.escape(source)+'</code></pre></details></figure>')

def inline(value):
    codes=[]
    def code(m):
        codes.append('<code>'+html.escape(m.group(1))+'</code>')
        return f'\ue000{len(codes)-1}\ue001'
    value=re.sub(r'`([^`]+)`',code,value)
    value=html.escape(value)
    value=re.sub(r'!\[([^]]*)\]\(([^)]+)\)',lambda m:f'<figure><img loading="lazy" src="{m[2]}" alt="{m[1]}"><figcaption>{m[1]}</figcaption></figure>',value)
    def link(m):
        target=TARGETS.get(html.unescape(m[2]),m[2])
        return f'<a href="{target}">{m[1]}</a>'
    value=re.sub(r'\[([^]]+)\]\(([^)]+)\)',link,value)
    value=re.sub(r'\*\*([^*]+)\*\*',r'<strong>\1</strong>',value)
    value=re.sub(r'(?<!\*)\*([^*]+)\*(?!\*)',r'<em>\1</em>',value)
    for i,c in enumerate(codes): value=value.replace(f'\ue000{i}\ue001',c)
    return value

def render(source,slug):
    lines=source.splitlines(); output=[]; i=0; heading=0; diagram=0
    while i<len(lines):
        line=lines[i]
        if not line.strip(): i+=1; continue
        image=re.fullmatch(r'!\[([^]]*)\]\(([^)]+)\)',line)
        if image and image[2].startswith('assets/plantuml/'):
            if image[2] not in PLANTUML: raise SystemExit('Missing PlantUML manifest entry: '+image[2])
            diagram+=1
            output.append(plantuml_figure(image[2],image[1],f'{slug}-diagram-{diagram}'))
            i+=1; continue
        if line.startswith('```'):
            language=line[3:].strip()
            body=[]; i+=1
            while i<len(lines) and not lines[i].startswith('```'): body.append(lines[i]); i+=1
            if language=='mermaid':
                diagram+=1
                output.append(f'<figure class="diagram" id="{slug}-diagram-{diagram}" data-diagram-language="mermaid" data-diagram-state="waiting">'
                    '<div class="diagram-output" role="img" aria-label="Mermaid 流程图">正在渲染流程图…</div>'
                    '<p class="diagram-error" role="status" hidden></p>'
                    '<details class="diagram-source"><summary>查看 Mermaid 源码</summary><pre><code class="language-mermaid">'
                    +html.escape('\n'.join(body))+'</code></pre></details>'
                    '<noscript>启用 JavaScript 后可以查看流程图；也可展开上面的 Mermaid 源码。</noscript></figure>')
            else:
                output.append('<pre><code class="language-'+html.escape(language,quote=True)+'">'+html.escape('\n'.join(body))+'</code></pre>')
            i+=1; continue
        if line.startswith('|'):
            rows=[]
            while i<len(lines) and lines[i].startswith('|'):
                row=lines[i].strip().strip('|').split('|')
                if not all(re.fullmatch(r'\s*:?-+:?\s*',cell) for cell in row): rows.append(row)
                i+=1
            header=''.join('<th>'+inline(cell.strip())+'</th>' for cell in rows[0])
            body=''.join('<tr>'+''.join('<td>'+inline(cell.strip())+'</td>' for cell in row)+'</tr>' for row in rows[1:])
            output.append('<div class="table-wrap"><table><thead><tr>'+header+'</tr></thead><tbody>'+body+'</tbody></table></div>'); continue
        m=re.match(r'^(#{1,6}) (.+)',line)
        if m:
            heading+=1; level=len(m[1]); output.append(f'<h{level} id="{slug}-h{heading}">'+inline(m[2])+f'</h{level}>'); i+=1; continue
        if line.startswith('>'):
            body=[]
            while i<len(lines) and lines[i].startswith('>'): body.append(inline(lines[i][1:].strip())); i+=1
            output.append('<blockquote>'+'<br>'.join(body)+'</blockquote>'); continue
        if re.match(r'^(?:- |\d+\. )',line):
            ordered=not line.startswith('- '); tag='ol' if ordered else 'ul'; body=[]
            while i<len(lines) and re.match(r'^(?:- |\d+\. )',lines[i]):
                body.append('<li>'+inline(re.sub(r'^(?:- |\d+\. )','',lines[i]))+'</li>'); i+=1
            output.append('<'+tag+'>'+''.join(body)+'</'+tag+'>'); continue
        output.append('<p>'+inline(line)+'</p>'); i+=1
    return '\n'.join(output)

sections=[]; nav=[]
for name,slug,title in FILES:
    source=read_chapter(name)
    sections.append(f'<article id="{slug}" class="chapter"'+('' if slug=='guide' else ' hidden')+'>'+render(source,slug)+'</article>')
    nav.append(f'<a class="chapter-link" href="#{slug}" data-target="{slug}">{html.escape(title)}</a>')

style='''
:root{--ink:#17243a;--muted:#52647d;--accent:#0f766e;--line:#dbe4ef}*{box-sizing:border-box}
body{margin:0;font:16px/1.85 "Segoe UI","Microsoft YaHei",sans-serif;background:#f3f6fb;color:var(--ink)}
aside{position:fixed;inset:0 auto 0 0;width:274px;background:#15283d;color:#fff;padding:32px 22px;overflow:auto}
.brand{font-size:24px;font-weight:750;line-height:1.4}.sub{font-size:13px;color:#b6c9db;margin:12px 0 26px}
nav a{display:block;padding:11px 14px;margin:4px 0;color:#d3e1ef;text-decoration:none;border-radius:8px;font-size:14px}
nav a.active{background:#1e5461;color:#fff;border-left:3px solid #5eead4}nav a:hover{background:#28465f}
main{margin-left:274px;padding:30px 40px 70px;max-width:1740px}.top{display:flex;gap:12px;flex-wrap:wrap;align-items:center;margin-bottom:24px}
input{flex:1;min-width:210px;font:inherit;border:1px solid var(--line);border-radius:9px;padding:9px 14px;background:white}
button{font:inherit;cursor:pointer;border:1px solid var(--line);border-radius:9px;background:white;padding:9px 16px;color:var(--ink)}
.chapter{background:white;border:1px solid var(--line);border-radius:16px;padding:30px 38px;box-shadow:0 5px 22px #132a4d06}
h1{font-size:30px;line-height:1.5;margin:0 0 24px}h2{font-size:23px;margin:40px 0 15px;border-top:1px solid var(--line);padding-top:26px}h3{font-size:19px;margin:28px 0 12px}
p{margin:12px 0}a{color:#146077;text-underline-offset:3px}li{margin:7px 0}blockquote{margin:20px 0;padding:14px 20px;background:#edf7f6;border-left:4px solid #27968a;border-radius:0 8px 8px 0;color:#335363}
figure{margin:26px 0}img{display:block;max-width:100%;height:auto;border-radius:12px}figcaption{font-size:13px;color:var(--muted);margin-top:8px;text-align:center}
.table-wrap{overflow:auto;margin:20px 0;border:1px solid var(--line);border-radius:10px}table{border-collapse:collapse;width:100%;font-size:14px;line-height:1.75}
th,td{padding:12px 14px;text-align:left;vertical-align:top;border-bottom:1px solid var(--line);min-width:90px}th{background:#edf3f8;color:#23435d}tr:last-child td{border-bottom:0}tr:nth-child(even){background:#fafcfe}
code{font:13px/1.75 Consolas,monospace;background:#edf2f7;border-radius:4px;padding:2px 5px;word-break:break-word}pre{overflow:auto;background:#14283d;color:#d9e7f2;padding:18px 22px;border-radius:10px}pre code{background:none;padding:0;color:inherit;white-space:pre}
.diagram{border:1px solid var(--line);border-radius:10px;overflow:hidden}.diagram-output{padding:18px;overflow:auto;background:#fff;min-height:80px}.diagram-output svg{display:block;max-width:100%;height:auto;margin:auto}.diagram-source{border-top:1px solid var(--line);padding:10px 16px;font-size:13px}.diagram-source summary{cursor:pointer;color:#146077}.diagram-source pre{margin-bottom:6px}.diagram-error{margin:0;padding:12px 16px;color:#9f1239;background:#fff1f2}.diagram-measure{position:fixed;left:-100000px;top:0;visibility:hidden;pointer-events:none;background:white}.diagram-status{font-size:13px;color:var(--muted)}button:disabled{cursor:wait;opacity:.6}.note{margin-top:30px;font-size:13px;color:#b6c9db}.search-status{font-size:13px;color:var(--muted)}[hidden]{display:none!important}
@media(max-width:1000px){aside{position:static;width:auto;padding:20px}nav{display:flex;flex-wrap:wrap}nav a{padding:7px 10px}main{margin:0;padding:20px}.chapter{padding:24px}h1{font-size:25px}}
@media print{aside,.top,.diagram-source,.diagram-measure{display:none}main{margin:0;padding:0;max-width:none}.chapter{display:block!important;break-before:page;border:0;box-shadow:none;padding:0}.chapter:first-child{break-before:auto}body{font-size:11pt;background:white}figure,img{break-inside:avoid}h2,h3{break-after:avoid}.table-wrap{overflow:visible}table{font-size:9pt}a{color:inherit}pre{white-space:pre-wrap}.diagram-output{overflow:visible;padding:8px} }
'''
script='''
const chapters=[...document.querySelectorAll('.chapter')];
const links=[...document.querySelectorAll('.chapter-link')];
function show(){const id=location.hash.slice(1)||'guide';const chapter=chapters.find(x=>x.id===id)||chapters[0];
chapters.forEach(x=>x.hidden=x!==chapter);links.forEach(x=>{x.classList.toggle('active',x.dataset.target===chapter.id);if(x.dataset.target===chapter.id)x.setAttribute('aria-current','page');else x.removeAttribute('aria-current')});
document.title=chapter.querySelector('h1').textContent+' · MusicFree 知识库';window.scrollTo(0,0)}
window.addEventListener('hashchange',show);show();
document.querySelector('#search').addEventListener('input',e=>{const q=e.target.value.trim().toLowerCase();let count=0;
links.forEach(link=>{const chapter=chapters.find(x=>x.id===link.dataset.target);const match=!q||chapter.textContent.toLowerCase().includes(q);link.hidden=!match;if(match)count++});
document.querySelector('#search-status').textContent=q?count+' 个章节包含关键词；选择左侧章节后可用 Ctrl+F 定位':''});
document.querySelector('#print').addEventListener('click',()=>window.print());
async function renderDiagrams(){
const figures=[...document.querySelectorAll('.diagram')];
const status=document.querySelector('#diagram-status');
const result={total:figures.length,rendered:0,failed:0};
const staging=document.createElement('div');staging.className='diagram-measure';
staging.style.width=Math.max(320,Math.min(1200,document.querySelector('.chapter:not([hidden])').clientWidth-76))+'px';
document.body.append(staging);
try{
    if(document.fonts)await document.fonts.ready;
    if(window.mermaid)window.mermaid.initialize({startOnLoad:false,securityLevel:'strict',theme:'default',
        fontFamily:'Segoe UI, Microsoft YaHei, sans-serif',flowchart:{htmlLabels:false,useMaxWidth:true},
        sequence:{useMaxWidth:true},suppressErrorRendering:true});
    for(const figure of figures){
        const output=figure.querySelector('.diagram-output');
        try{
            if(figure.dataset.diagramLanguage==='plantuml'){
                if(!output.querySelector('svg'))throw new Error('PlantUML 本地图形缺失，请重新生成知识库。');
                figure.dataset.diagramState='rendered';result.rendered++;
            }else{
                if(!window.mermaid)throw new Error('Mermaid 渲染库未加载，请确认 vendor 文件夹与 index.html 一起保存。');
                // Offscreen layout remains measurable even when a chapter is hidden.
                const source=figure.querySelector('code.language-mermaid').textContent;
                const rendered=await window.mermaid.render('render-'+figure.id,source,staging);
                output.innerHTML=rendered.svg;
                rendered.bindFunctions?.(output);
                figure.dataset.diagramState='rendered';result.rendered++;
            }
        }catch(error){
            output.textContent='流程图未能渲染。';
            const message=figure.querySelector('.diagram-error');message.hidden=false;
            message.textContent=String(error.message||error);
            figure.querySelector('.diagram-source').open=true;
            figure.dataset.diagramState='failed';result.failed++;
        }finally{staging.replaceChildren();}
        status.textContent='流程图：'+result.rendered+'/'+result.total+' 已渲染'+(result.failed?'，'+result.failed+' 张失败':'');
    }
}finally{staging.remove();document.querySelector('#print').disabled=false;}
document.documentElement.dataset.diagramStatus=result.failed?'failed':'ready';
return result;
}
window.knowledgeBaseReady=renderDiagrams();
'''
page='''<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MusicFreeDesktop 知识库</title><style>'''+style+'''</style></head><body>
<aside><div class="brand">MusicFreeDesktop<br>代码知识库</div><p class="sub">2026-10-04 · 提交审查 4e7b711<br>源码 / Mermaid / PlantUML / 三平台</p><nav aria-label="知识库章节">'''+''.join(nav)+'''</nav><p class="note">第一阶段：保留现有架构。<br>历史 BUG-01～14 已修复并验证。<br>近期提交另发现 3 项 P1 数据风险，见 08。<br>Mermaid / PlantUML 图均可查看源码。<br>渲染库随文档保存，可离线阅读。</p></aside>
<main><div class="top"><input id="search" type="search" aria-label="搜索章节全文" placeholder="搜索：下载、Windows、BUG-01、插件…"><button id="print" disabled>打印 / 导出 PDF</button><a href="README.md">Markdown 原稿</a><span id="diagram-status" class="diagram-status" role="status">流程图：正在准备…</span><span id="search-status" class="search-status" role="status"></span></div>'''+''.join(sections)+'''</main><script src="vendor/mermaid/mermaid.min.js"></script><script>'''+script+'''</script></body></html>'''
(ROOT/'index.html').write_text(page,encoding='utf8')
print('Generated offline HTML for',len(FILES),'chapters with offline Mermaid and PlantUML diagrams')
