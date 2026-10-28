# 廊坊一中回忆录 —— 快速自检脚本（Windows PowerShell 5.1+ / PowerShell 7）
# 用法：先 npm start 起服务，另开一个终端：
#   powershell -ExecutionPolicy Bypass -File scripts/smoke.ps1
# 可选参数：-Base http://localhost:3000  -AdminPassword xxx
# 说明：脚本会写入几条测试数据（1998级3班 张三 等），跑完可在后台删除。

param(
  [string]$Base = 'http://localhost:3000',
  [string]$AdminPassword = ''
)

$ErrorActionPreference = 'Stop'
$script:pass = 0
$script:fail = 0

function Check {
  param([string]$name, [scriptblock]$body)
  try {
    $ok = & $body
    if ($ok) { Write-Host "  [OK]   $name" -ForegroundColor Green; $script:pass++ }
    else { Write-Host "  [FAIL] $name" -ForegroundColor Red; $script:fail++ }
  } catch {
    Write-Host "  [FAIL] $name -> $($_.Exception.Message)" -ForegroundColor Red
    $script:fail++
  }
}

# 统一的接口调用：JSON 一律按 UTF-8 发送（中文名不会乱码）
function Api {
  param(
    [string]$Method = 'GET',
    [string]$Path,
    [object]$Body = $null,
    [object]$Session = $null
  )
  $p = @{
    Method          = $Method
    Uri             = "$Base$Path"
    UseBasicParsing = $true
    TimeoutSec      = 30
  }
  if ($null -ne $Body) {
    $p.ContentType = 'application/json; charset=utf-8'
    $p.Body = [System.Text.Encoding]::UTF8.GetBytes(($Body | ConvertTo-Json -Depth 8))
  }
  if ($null -ne $Session) { $p.WebSession = $Session }
  return Invoke-RestMethod @p
}

# 期望失败的调用：返回 HTTP 状态码
function ApiStatus {
  param([string]$Method = 'GET', [string]$Path, [object]$Body = $null, [object]$Session = $null)
  try {
    Api -Method $Method -Path $Path -Body $Body -Session $Session | Out-Null
    return 200
  } catch {
    $r = $_.Exception.Response
    if ($r) { return [int]$r.StatusCode }
    return -1
  }
}

function New-Session {
  return New-Object Microsoft.PowerShell.Commands.WebRequestSession
}

# multipart 上传（Windows PowerShell 5.1 的 Invoke-RestMethod 没有 -Form，只能用 HttpClient）
function Upload-File {
  param(
    [string]$Path,
    [string]$FilePath,
    [hashtable]$Fields = @{},
    [object]$Session = $null,
    [string]$FieldName = 'file'
  )
  Add-Type -AssemblyName System.Net.Http | Out-Null
  # UseCookies 必须关：开着时手写的 Cookie 头会被 HttpClient 丢掉，后端就认不出登录态（401）
  $handler = [System.Net.Http.HttpClientHandler]::new()
  $handler.UseCookies = $false
  $h = [System.Net.Http.HttpClient]::new($handler)
  $mp = [System.Net.Http.MultipartFormDataContent]::new()
  $bytes = [System.IO.File]::ReadAllBytes($FilePath)
  $fc = [System.Net.Http.ByteArrayContent]::new($bytes)
  $mp.Add($fc, $FieldName, [System.IO.Path]::GetFileName($FilePath))
  foreach ($k in $Fields.Keys) {
    $sc = [System.Net.Http.StringContent]::new([string]$Fields[$k])
    $mp.Add($sc, $k)
  }
  if ($null -ne $Session) {
    $cs = $Session.Cookies.GetCookies([uri]$Base) | ForEach-Object { "$($_.Name)=$($_.Value)" }
    if ($cs) { $h.DefaultRequestHeaders.Add('Cookie', ($cs -join '; ')) }
  }
  $resp = $h.PostAsync("$Base$Path", $mp).GetAwaiter().GetResult()
  $txt = $resp.Content.ReadAsStringAsync().GetAwaiter().GetResult()
  $h.Dispose()
  $obj = $null
  try { $obj = $txt | ConvertFrom-Json } catch { }
  return [pscustomobject]@{ status = [int]$resp.StatusCode; body = $obj; text = $txt }
}

Write-Host "`n== 廊坊一中回忆录 自检 @ $Base ==`n" -ForegroundColor Cyan

# ================= 1. 页面 =================
Write-Host '1) 页面可用性'
Check 'GET /healthz' { (Api -Path '/healthz').ok -eq $true }
Check 'GET / 返回 200 且含「廊坊一中」' {
  $r = Invoke-WebRequest "$Base/" -UseBasicParsing
  $r.StatusCode -eq 200 -and $r.Content -match '廊坊一中'
}
foreach ($p in '/wall.html', '/admin.html', '/account.html', '/404.html', '/assets/style.css', '/assets/common.js', '/assets/login.js', '/assets/wall.js', '/assets/admin.js', '/assets/account.js') {
  Check "GET $p" { (Invoke-WebRequest "$Base$p" -UseBasicParsing).StatusCode -eq 200 }
}
Check 'GET /admin 友好路由' { (Invoke-WebRequest "$Base/admin" -UseBasicParsing).StatusCode -eq 200 }

# ================= 2. 登记 / 登录 / 密码 =================
Write-Host "`n2) 校友登记 / 登录 / 密码"
$S1 = New-Session
$S2 = New-Session
$S3 = New-Session
$script:u1 = $null
$script:tmpPwd = ''
Check '未登录 /api/me 返回 user:null' { $null -eq (Api -Path '/api/me').user }

Check 'POST /api/register 登记「1998级3班 张三」并设密码' {
  $script:u1 = Api -Method POST -Path '/api/register' -Session $S1 -Body @{ who = '1998级3班 张三'; password = 'zhang123'; password2 = 'zhang123' }
  $script:u1.user.label -eq '98级3班张三' -and $script:u1.user.hasPassword -eq $true
}
Check 'GET /api/me 已登录' { (Api -Path '/api/me' -Session $S1).user.name -eq '张三' }
Check '同一身份重复登记被拒（409）' {
  (ApiStatus -Method POST -Path '/api/register' -Body @{ who = '1998级3班 张三'; password = 'another' }) -eq 409
}
Check '密码错误登录被拒（401）' {
  (ApiStatus -Method POST -Path '/api/login' -Body @{ who = '1998级3班 张三'; password = 'wrong-one' }) -eq 401
}
Check 'POST /api/login 密码正确（不写班级也认）' {
  $l = Api -Method POST -Path '/api/login' -Session $S2 -Body @{ who = '1998级 张三'; password = 'zhang123' }
  $l.user.id -eq $u1.user.id
}
Check '两次密码不一致被拒（400）' {
  (ApiStatus -Method POST -Path '/api/register' -Body @{ who = '2002级1班 孙七'; password = 'a1'; password2 = 'a2' }) -eq 400
}
Check '非法级别 1800 被拒（400）' {
  (ApiStatus -Method POST -Path '/api/register' -Body @{ who = '1800级 李四'; password = 'x' }) -eq 400
}
Check '空姓名被拒（400）' {
  (ApiStatus -Method POST -Path '/api/register' -Body @{ who = '2000级'; password = 'x' }) -eq 400
}
Check '同年同名两人 → 登录要求写班级（409）' {
  Api -Method POST -Path '/api/register' -Body @{ who = '2001级1班 王五'; password = 'w1' } | Out-Null
  Api -Method POST -Path '/api/register' -Body @{ who = '2001级2班 王五'; password = 'w2' } | Out-Null
  (ApiStatus -Method POST -Path '/api/login' -Body @{ who = '2001级 王五'; password = 'w1' }) -eq 409
}
Check '旧密码不对时不能改（400）' {
  (ApiStatus -Method POST -Path '/api/password' -Session $S2 -Body @{ oldPassword = 'nope'; newPassword = 'new456' }) -eq 400
}
Check '改密码成功，其它设备掉线' {
  $r = Api -Method POST -Path '/api/password' -Session $S2 -Body @{ oldPassword = 'zhang123'; newPassword = 'new456' }
  $kicked = $null -eq (Api -Path '/api/me' -Session $S1).user
  $r.ok -eq $true -and $kicked
}
Check '新密码能登录' {
  (Api -Method POST -Path '/api/login' -Session $S3 -Body @{ who = '1998级3班 张三'; password = 'new456' }).user.name -eq '张三'
}
$S1 = $S3  # 后面发回忆用它（密码已换）

# ================= 3. 回忆墙 =================
Write-Host "`n3) 回忆墙接口"
$script:post = $null
Check 'POST /api/posts 发一条回忆' {
  $script:post = Api -Method POST -Path '/api/posts' -Session $S1 -Body @{
    title   = '那年冬天'
    content = '记得那年冬天特别冷，教室的暖气片半夜不热，大家裹着军大衣上早自习。'
    images  = @()
  }
  [bool]$script:post.post.id
}
Check 'GET /api/posts 列表能读到' {
  $list = Api -Path '/api/posts'
  @($list.items | Where-Object { $_.id -eq $post.post.id }).Count -eq 1
}
Check 'GET /api/posts/:id 详情' {
  (Api -Path "/api/posts/$($post.post.id)").post.title -eq '那年冬天'
}
Check 'POST 点赞' {
  (Api -Method POST -Path "/api/posts/$($post.post.id)/like" -Session $S1).liked -eq $true
}
Check 'POST 评论' {
  Api -Method POST -Path "/api/posts/$($post.post.id)/comments" -Session $S1 -Body @{ content = '我也是那年毕业的，还记得吗' } | Out-Null
  (Api -Path "/api/posts/$($post.post.id)/comments").items.Count -eq 1
}
Check 'GET /api/stats 统计正确' {
  $s = Api -Path '/api/stats'
  $s.postCount -ge 1 -and $s.userCount -ge 1 -and $s.commentCount -ge 1
}
Check '未登录不能发帖（401）' {
  (ApiStatus -Method POST -Path '/api/posts' -Body @{ content = '路人甲随便说说' }) -eq 401
}
Check '正文太短被拒（400）' {
  (ApiStatus -Method POST -Path '/api/posts' -Session $S1 -Body @{ content = '啊' }) -eq 400
}
Check '含 <script> 被拒（400）' {
  (ApiStatus -Method POST -Path '/api/posts' -Session $S1 -Body @{ content = '<script>alert(1)</script> 坏东西' }) -eq 400
}
Check '搜索「暖气」能命中' { (Api -Path '/api/posts?q=暖气').items.Count -ge 1 }
Check '按届别筛选 1998' { (Api -Path '/api/posts?year=1998').items.Count -ge 1 }

# ================= 4. 后台 =================
Write-Host "`n4) 后台监控"
if (-not $AdminPassword) {
  $f = Join-Path (Split-Path $PSScriptRoot -Parent) 'data\.admin-password'
  if (Test-Path $f) { $AdminPassword = (Get-Content $f -Raw).Trim() }
}
$SA = New-Session
if (-not $AdminPassword) {
  Write-Host '  [跳过] 没找到后台密码（data/.admin-password），可用 -AdminPassword 传入' -ForegroundColor Yellow
  $script:fail++
} else {
  Check '错误密码登录后台应失败（401）' {
    (ApiStatus -Method POST -Path '/api/admin/login' -Body @{ password = 'definitely-wrong' }) -eq 401
  }
  Check 'POST /api/admin/login 成功' {
    Api -Method POST -Path '/api/admin/login' -Session $SA -Body @{ password = $AdminPassword } | Out-Null
    (Api -Path '/api/admin/ping' -Session $SA).ok -eq $true
  }
  Check 'GET /api/admin/overview 概览' {
    $o = Api -Path '/api/admin/overview' -Session $SA
    $o.total.users -ge 1 -and $o.today.pv -ge 1 -and $o.hourBuckets.Count -eq 24
  }
  Check 'GET /api/admin/visits 记下了刚才的请求' {
    $v = Api -Path '/api/admin/visits?limit=50' -Session $SA
    $v.items.Count -gt 0 -and @($v.items | Where-Object { $_.path -like '/api/*' }).Count -gt 0
  }
  Check 'GET /api/admin/visitors 访客档案' { (Api -Path '/api/admin/visitors' -Session $SA).items.Count -ge 1 }
  Check 'GET /api/admin/logins 登录记录' { (Api -Path '/api/admin/logins' -Session $SA).items.Count -ge 1 }
  Check '后台接口未登录不可访问（401）' { (ApiStatus -Path '/api/admin/overview') -eq 401 }
  Check '封禁 -> 出现在名单 -> 解除' {
    $ip = '203.0.113.66'
    Api -Method POST -Path '/api/admin/bans' -Session $SA -Body @{ ip = $ip; reason = '自检脚本' } | Out-Null
    $inList = @((Api -Path '/api/admin/bans' -Session $SA).items | Where-Object { $_.ip -eq $ip }).Count -eq 1
    Api -Method DELETE -Path "/api/admin/bans/$ip" -Session $SA | Out-Null
    $gone = @((Api -Path '/api/admin/bans' -Session $SA).items | Where-Object { $_.ip -eq $ip }).Count -eq 0
    $inList -and $gone
  }
  Check '非法 IP 不能进封禁名单（400）' {
    (ApiStatus -Method POST -Path '/api/admin/bans' -Session $SA -Body @{ ip = 'not-an-ip' }) -eq 400
  }

  # ================= 5. 导入 =================
  Write-Host "`n5) 导入共享文档（粘贴文本方式）"
  $doc = @"
1999级1班 李四
高三那年我们一起翻墙出去吃烧烤，被教导主任抓住了，写了三千字检讨。

2000级 王五
我只记得操场边那排杨树，还有每天早上的广播体操音乐。

1997级2班 赵六
毕业照那天下了小雨，照相馆的人说等天晴再来，结果一等就是二十六年。
"@
  $parsed = $null
  Check 'POST /api/admin/import/text 解析出 3 条' {
    $script:parsed = Api -Method POST -Path '/api/admin/import/text' -Session $SA -Body @{ text = $doc }
    $script:parsed.entries.Count -eq 3
  }
  Check '署名解析正确（1999级1班 李四）' {
    $e = $parsed.entries[0]
    $e.year -eq 1999 -and $e.className -eq '1' -and $e.name -eq '李四' -and $e.content -match '翻墙'
  }
  Check '其余署名也认（2000级 / 1997级2班）' {
    $parsed.entries[1].year -eq 2000 -and $parsed.entries[2].className -eq '2'
  }
  Check 'POST /api/admin/import/commit 写入 3 条' {
    $r = Api -Method POST -Path '/api/admin/import/commit' -Session $SA -Body @{ entries = $parsed.entries }
    $r.created -eq 3
  }
  Check '导入后搜索「翻墙」能查到' { (Api -Path '/api/posts?q=翻墙').items.Count -ge 1 }
  Check '重复导入会被跳过（不会写两遍）' {
    $r2 = Api -Method POST -Path '/api/admin/import/commit' -Session $SA -Body @{ entries = $parsed.entries }
    $r2.created -eq 0 -and $r2.skipped -ge 3
  }
  Check '导出 CSV 带 BOM（Excel 不乱码）' {
    $resp = Invoke-WebRequest "$Base/api/admin/export?type=users" -WebSession $SA -UseBasicParsing
    $bytes = $resp.RawContentStream.ToArray()
    $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF
  }
  Check 'GET /api/admin/settings 能读设置' { [bool](Api -Path '/api/admin/settings' -Session $SA).settings }
  Check 'POST /api/admin/settings 能存设置' {
    $s = (Api -Path '/api/admin/settings' -Session $SA).settings
    Api -Method POST -Path '/api/admin/settings' -Session $SA -Body @{
      siteTitle        = $s.siteTitle
      notice           = '自检脚本写入的公告'
      sensitiveWords   = @('作弊')
      registrationOpen = $true
      reviewFirstPost  = $false
    } | Out-Null
    (Api -Path '/api/admin/settings' -Session $SA).settings.notice -eq '自检脚本写入的公告'
  }
  Check '敏感词生效（含「作弊」被拒）' {
    (ApiStatus -Method POST -Path '/api/posts' -Session $S1 -Body @{ content = '这场考试我作弊了，对不起老师。' }) -eq 400
  }
  Check '登录页有「联系站长」入口结构' {
    $html = (Invoke-WebRequest "$Base/index.html" -UseBasicParsing).Content
    $html -match 'contact-box' -and $html -match 'contact-toggle' -and $html -match 'contact-panel'
  }
  Check '后台存联系方式 → 登录页接口能拿到' {
    Api -Method POST -Path '/api/admin/settings' -Session $SA -Body @{
      contact = @{ enabled = $true; wechat = 'smoke_wx'; qq = '10001'; email = 'a@b.com'; phone = '13800000000'; note = '自检写入' }
    } | Out-Null
    $c = (Api -Path '/api/me').settings.contact
    $c.wechat -eq 'smoke_wx' -and $c.qq -eq '10001' -and $c.email -eq 'a@b.com' -and $c.note -eq '自检写入'
  }
  Check '关闭展示开关后对外不可见' {
    Api -Method POST -Path '/api/admin/settings' -Session $SA -Body @{ contact = @{ enabled = $false } } | Out-Null
    $null -eq (Api -Path '/api/me').settings.contact
  }
  Check '只填备注不算联系方式（入口不出现）' {
    Api -Method POST -Path '/api/admin/settings' -Session $SA -Body @{
      contact = @{ enabled = $true; wechat = ''; qq = ''; email = ''; phone = ''; note = '只有备注' }
    } | Out-Null
    $hidden = $null -eq (Api -Path '/api/me').settings.contact
    # 收尾：清空，别把自检数据留在库里
    Api -Method POST -Path '/api/admin/settings' -Session $SA -Body @{
      contact = @{ enabled = $true; wechat = ''; qq = ''; email = ''; phone = ''; note = '' }
    } | Out-Null
    $hidden
  }

  # ================= 6. 密码管控 =================
  Write-Host "`n6) 密码管控（站长视角）"
  $uid = $u1.user.id
  Check 'GET /api/admin/accounts 列表与统计' {
    $a = Api -Path '/api/admin/accounts' -Session $SA
    $a.items.Count -ge 1 -and $a.stats.users -ge 1 -and $a.stats.withPwd -ge 1
  }
  Check '按「没设密码」筛选不报错' { $null -ne (Api -Path '/api/admin/accounts?status=nopwd' -Session $SA).items }
  Check '账号表能导出' {
    (Invoke-WebRequest "$Base/api/admin/export?type=accounts" -WebSession $SA -UseBasicParsing).StatusCode -eq 200
  }
  Check '重置密码 → 生成临时密码 + 踢下线' {
    $r = Api -Method POST -Path "/api/admin/accounts/$uid/password" -Session $SA -Body @{}
    $script:tmpPwd = $r.password
    $r.generated -eq $true -and $r.password.Length -ge 6 -and $r.kicked -ge 1
  }
  Check '临时密码能登录且要求改密' {
    $l = Api -Method POST -Path '/api/login' -Body @{ who = '1998级3班 张三'; password = $tmpPwd }
    $l.user.mustChange -eq $true -and $l.next -like '/account.html*'
  }
  Check '锁定后登录被拒（429）' {
    Api -Method POST -Path "/api/admin/accounts/$uid/lock" -Session $SA -Body @{ minutes = 5 } | Out-Null
    (ApiStatus -Method POST -Path '/api/login' -Body @{ who = '1998级3班 张三'; password = $tmpPwd }) -eq 429
  }
  Check '解锁后能登录' {
    Api -Method POST -Path "/api/admin/accounts/$uid/unlock" -Session $SA | Out-Null
    (ApiStatus -Method POST -Path '/api/login' -Body @{ who = '1998级3班 张三'; password = $tmpPwd }) -eq 200
  }
  Check '连续输错到上限会被自动锁定' {
    Api -Method POST -Path '/api/admin/password/policy' -Session $SA -Body @{ maxFail = 2; lockMinutes = 1 } | Out-Null
    ApiStatus -Method POST -Path '/api/login' -Body @{ who = '1998级3班 张三'; password = 'bad-1' } | Out-Null
    $s = ApiStatus -Method POST -Path '/api/login' -Body @{ who = '1998级3班 张三'; password = 'bad-2' }
    Api -Method POST -Path '/api/admin/password/policy' -Session $SA -Body @{ maxFail = 8; lockMinutes = 30 } | Out-Null
    Api -Method POST -Path "/api/admin/accounts/$uid/unlock" -Session $SA | Out-Null
    $s -eq 429
  }
  Check '停用后不能登录（403）' {
    Api -Method POST -Path "/api/admin/accounts/$uid/disabled" -Session $SA -Body @{ disabled = $true } | Out-Null
    (ApiStatus -Method POST -Path '/api/login' -Body @{ who = '1998级3班 张三'; password = $tmpPwd }) -eq 403
  }
  Check '恢复启用后能登录' {
    Api -Method POST -Path "/api/admin/accounts/$uid/disabled" -Session $SA -Body @{ disabled = $false } | Out-Null
    (ApiStatus -Method POST -Path '/api/login' -Body @{ who = '1998级3班 张三'; password = $tmpPwd }) -eq 200
  }
  Check '要求改密标记有效' {
    Api -Method POST -Path "/api/admin/accounts/$uid/must-change" -Session $SA -Body @{ mustChange = $true } | Out-Null
    (Api -Method POST -Path '/api/login' -Body @{ who = '1998级3班 张三'; password = $tmpPwd }).user.mustChange -eq $true
  }
  Check '密码策略可读可改' {
    $p = (Api -Path '/api/admin/password/policy' -Session $SA).policy
    Api -Method POST -Path '/api/admin/password/policy' -Session $SA -Body @{ minLength = 4 } | Out-Null
    $after = (Api -Path '/api/admin/password/policy' -Session $SA).policy.minLength
    Api -Method POST -Path '/api/admin/password/policy' -Session $SA -Body @{ minLength = $p.minLength } | Out-Null
    $p.minLength -ge 1 -and $after -eq 4
  }
  Check '密码日志留痕' { (Api -Path '/api/admin/password/logs' -Session $SA).items.Count -ge 3 }

  # ================= 7. 站长自己的后台密码（最后跑，会踢掉后台会话）=================
  Write-Host "`n7) 站长后台密码"
  Check 'GET /api/admin/password/self 可读状态' { $null -ne (Api -Path '/api/admin/password/self' -Session $SA) }
  Check '当前密码不对时改不了（401）' {
    (ApiStatus -Method POST -Path '/api/admin/password/self' -Session $SA -Body @{ currentPassword = 'wrong'; newPassword = 'admin999' }) -eq 401
  }
  Check '改后台密码 → 新密码能登录 → 再改回 .env' {
    Api -Method POST -Path '/api/admin/password/self' -Session $SA -Body @{ currentPassword = $AdminPassword; newPassword = 'admin999' } | Out-Null
    $SB = New-Session
    Api -Method POST -Path '/api/admin/login' -Session $SB -Body @{ password = 'admin999' } | Out-Null
    $ok = (Api -Path '/api/admin/ping' -Session $SB).ok -eq $true
    Api -Method POST -Path '/api/admin/password/self' -Session $SB -Body @{ currentPassword = 'admin999'; useEnv = $true } | Out-Null
    $SC = New-Session
    Api -Method POST -Path '/api/admin/login' -Session $SC -Body @{ password = $AdminPassword } | Out-Null
    $back = (Api -Path '/api/admin/ping' -Session $SC).ok -eq $true
    $ok -and $back
  }

  # ================= 8. 传文档（校友直发墙壁）+ 监控中心 =================
  Write-Host "`n8) 传文档 / 监控中心"
  $SD = New-Session
  Api -Method POST -Path '/api/admin/login' -Session $SD -Body @{ password = $AdminPassword } | Out-Null
  $SU = New-Session
  $SV = New-Session

  Check 'GET /wall.html 的写回忆弹窗里有文档上传框' {
    $html = (Invoke-WebRequest "$Base/wall.html" -UseBasicParsing).Content
    $html -match 'id="w-doc"' -and $html -match 'id="w-doc-result"'
  }
  Check 'GET /monitor.html 是监控页' {
    (Invoke-WebRequest "$Base/monitor.html" -UseBasicParsing).Content -match 'monitor'
  }
  Check '旧的分享页已经下线（/share.html 404）' {
    (ApiStatus -Path '/share.html') -eq 404
  }
  Check '未登录不能传文档（401）' { (ApiStatus -Path '/api/docs/mine') -eq 401 }
  Check '登记一个测文档的校友（1997级4班 周八）' {
    $script:u2 = Api -Method POST -Path '/api/register' -Session $SU -Body @{ who = '1997级4班 周八'; password = 'zhou12345' }
    $script:u2.user.name -eq '周八'
  }

  $tmpDoc = Join-Path $env:TEMP 'mem-smoke-doc.txt'
  [System.IO.File]::WriteAllText($tmpDoc, "1996级5班 吴九`r`n高三那年冬天特别冷，我们在锅炉房里背书，谁也没喊过一声苦。`r`n`r`n1996级5班 吴九`r`n毕业那天谁也没哭，就是谁都不肯先走。", (New-Object System.Text.UTF8Encoding($false)))
  Check '上传 .txt 文档 → 解析成 2 条、状态 ready（不等审核）' {
    $u = Upload-File -Path '/api/docs/upload' -FilePath $tmpDoc -Session $SU -FieldName 'doc'
    $script:docId = $u.body.doc.id
    $u.status -eq 200 -and $u.body.total -eq 2 -and $u.body.doc.status -eq 'ready'
  }
  Check '.txt 不会被当成整篇模式（整篇只给 .docx）' {
    $u = Upload-File -Path '/api/docs/upload' -FilePath $tmpDoc -Session $SU -FieldName 'doc'
    $isTxtNotFlex = ($u.body.flex -ne $true) -and ($u.body.doc.flex -ne $true) -and ($u.body.doc.imageCount -eq 0)
    $mid = $u.body.doc.id
    Api -Method DELETE -Path "/api/docs/$mid" -Session $SU | Out-Null
    $isTxtNotFlex
  }
  Check '后台导入上限是 2.5GB，且大于校友侧上限' {
    $lim = Api -Path '/api/admin/import/limits' -Session $SD
    $lim.maxImportMb -eq 2560 -and $lim.maxImportMb -gt $lim.maxUploadMb -and $lim.maxEntries -eq 5000
  }
  Check '后台导入 60MB 的 .txt 能流式解析（证明不受 500MB 校友上限影响）' {
    $big = Join-Path $env:TEMP 'mem-smoke-big.txt'
    # 用字符串重复拼出 ~60MB，比在 PS 里循环写几十万行快得多
    $one = "1994级2班 孙七`r`n那年我们在操场上跑操，广播里放着同一首歌，现在想起来还是那个调子，一遍又一遍。`r`n`r`n"
    $per = [System.Text.Encoding]::UTF8.GetByteCount($one)
    $times = [math]::Ceiling((60 * 1MB) / $per)
    [System.IO.File]::WriteAllText($big, ($one * $times), (New-Object System.Text.UTF8Encoding($false)))
    $sizeMb = [math]::Round((Get-Item $big).Length / 1MB, 1)
    $r = Upload-File -Path '/api/admin/import/file' -FilePath $big -Session $SD
    Remove-Item $big -Force -ErrorAction SilentlyContinue
    $ok = ($sizeMb -gt 55 -and $r.status -eq 200 -and $r.body.entries.Count -ge 100)
    # 清掉这条导入记录，别留在库里
    if ($r.body.fileId) { Api -Method DELETE -Path "/api/admin/monitor/files/$($r.body.fileId)" -Session $SD | Out-Null }
    $ok
  }

  Check '整篇文档模式：一份 .txt 整篇发成一条回忆（flex）' {
    $whole = Join-Path $env:TEMP 'mem-smoke-whole.txt'
    [System.IO.File]::WriteAllText($whole, "整篇自检专用开头：那年冬天的锅炉房。`r`n`r`n整篇自检专用结尾：毕业那天谁也没先走。", (New-Object System.Text.UTF8Encoding($false)))
    $r = Upload-File -Path '/api/admin/import/doc' -FilePath $whole -Session $SD -Fields @{ title = '整篇自检'; year = '1999' }
    Remove-Item $whole -Force -ErrorAction SilentlyContinue
    $script:docPostId = $r.body.postId
    $script:docRecId = $r.body.fileId
    $r.status -eq 200 -and $r.body.ok -eq $true -and $r.body.imageCount -eq 0
  }
  Check '整篇那条在墙上：flex 标记 + 详情能拿到正文 HTML' {
    $d = Api -Path "/api/posts/$($script:docPostId)" -Session $SD
    $d.post.flex -eq $true -and $d.post.html -match 'doc-p'
  }
  Check '转换器把 Word 超链接 / 域代码 / 裸网址都变成可点的链接' {
    $script = Join-Path $PSScriptRoot 'test-docx.js'
    & node $script 2>&1 | Out-Null
    $LASTEXITCODE -eq 0
  }
  Check '站长删整篇记录 → 连着这条回忆一起删（404）' {
    $del = Api -Method DELETE -Path "/api/admin/monitor/files/$($script:docRecId)" -Session $SD
    $code = ApiStatus -Path "/api/posts/$($script:docPostId)"
    $del.posts -ge 1 -and $code -eq 404
  }

  Check 'GET /api/docs/mine 能看到自己传的文档' {
    @((Api -Path '/api/docs/mine' -Session $SU).items | Where-Object { $_.id -eq $script:docId }).Count -eq 1
  }
  Check '不认识的扩展名被拒（400）' {
    $bad = Join-Path $env:TEMP 'mem-smoke-bad.exe'
    [System.IO.File]::WriteAllText($bad, 'MZ', [System.Text.Encoding]::ASCII)
    (Upload-File -Path '/api/docs/upload' -FilePath $bad -Session $SU -FieldName 'doc').status -eq 400
  }
  Check '发布 → 回忆墙上真的多了这 2 条' {
    $r = Api -Method POST -Path "/api/docs/$script:docId/publish" -Session $SU
    $wall = Api -Path '/api/posts?q=%E7%82%89%E6%88%BF' -Session $SU
    $r.created -eq 2 -and $r.doc.status -eq 'published' -and $wall.total -ge 1
  }
  Check '同一份文档不能重复发布（400）' {
    (ApiStatus -Method POST -Path "/api/docs/$script:docId/publish" -Session $SU) -eq 400
  }

  Check 'GET /api/admin/monitor 一页看全（人 + 文件）' {
    $m = Api -Path '/api/admin/monitor' -Session $SD
    $m.stats.maxUploadMb -eq 500 -and $m.stats.docsToday -ge 1 -and $m.activity.Count -ge 1 -and $null -ne $m.online
  }
  Check 'GET /api/admin/monitor/files 列出上传记录' {
    $f = Api -Path '/api/admin/monitor/files' -Session $SD
    ($f.total -ge 1) -and (@($f.items | Where-Object { $_.id -eq $script:docId }).Count -eq 1)
  }
  Check '点开能看文档内容（解析出的条目 + 原文）' {
    $d = Api -Path "/api/admin/monitor/files/$script:docId" -Session $SD
    ($d.entriesSample.Count -ge 1) -and ($d.fullText.Length -gt 10)
  }
  Check '敏感词会在监控里标出来' {
    Api -Method POST -Path '/api/admin/settings' -Session $SD -Body @{ sensitiveWords = @('违禁词') } | Out-Null
    $bad2 = Join-Path $env:TEMP 'mem-smoke-doc2.txt'
    [System.IO.File]::WriteAllText($bad2, "1997级4班 周八`r`n这段话里故意写了违禁词三个字，用来测监控会不会标出来，顺便删掉它。", (New-Object System.Text.UTF8Encoding($false)))
    $u2 = Upload-File -Path '/api/docs/upload' -FilePath $bad2 -Session $SU -FieldName 'doc'
    Api -Method POST -Path '/api/admin/settings' -Session $SD -Body @{ sensitiveWords = @() } | Out-Null
    $script:docBadId = $u2.body.doc.id
    $u2.status -eq 200 -and $u2.body.doc.sensitive.Count -ge 1
  }
  Check '站长删文档 → 连带删掉它发到墙上的回忆' {
    Api -Method POST -Path "/api/docs/$($script:docBadId)/publish" -Session $SU | Out-Null
    $before = (Api -Path '/api/posts?q=%E8%BF%9D%E7%A6%81%E8%AF%8D' -Session $SD).total
    $del = Api -Method DELETE -Path "/api/admin/monitor/files/$($script:docBadId)" -Session $SD
    $after = (Api -Path '/api/posts?q=%E8%BF%9D%E7%A6%81%E8%AF%8D' -Session $SD).total
    $before -ge 1 -and $after -eq 0 -and $del.posts -ge 1
  }

  Check '登记第二个测文档的校友（1995级1班 郑十）' {
    (Api -Method POST -Path '/api/register' -Session $SV -Body @{ who = '1995级1班 郑十'; password = 'zheng12345' }).user.name -eq '郑十'
  }
  Check '没发布的文档能自己撤回' {
    $u3 = Upload-File -Path '/api/docs/upload' -FilePath $tmpDoc -Session $SV -FieldName 'doc'
    (Api -Method DELETE -Path "/api/docs/$($u3.body.doc.id)" -Session $SV).ok -eq $true
  }
  Check '别人不能发布我传的文档（403）' {
    $u4 = Upload-File -Path '/api/docs/upload' -FilePath $tmpDoc -Session $SV -FieldName 'doc'
    $code = ApiStatus -Method POST -Path "/api/docs/$($u4.body.doc.id)/publish" -Session $SU
    Api -Method DELETE -Path "/api/docs/$($u4.body.doc.id)" -Session $SV | Out-Null
    $code -eq 403
  }
  Check '监控里能踢人下线（会话立刻失效）' {
    Api -Method POST -Path "/api/admin/monitor/users/$($script:u2.user.id)/kick" -Session $SD | Out-Null
    $null -eq (Api -Path '/api/me' -Session $SU).user
  }
  Check '访问日志上限是 10 万条' {
    $ov = Api -Path '/api/admin/overview' -Session $SD
    $ov.retention.maxVisits -eq 100000
  }
  Check '能删掉一个访客（档案 + 访问记录，重复删 404）' {
    Api -Method POST -Path '/api/register' -Session $SU -Body @{ who = '1999级2班 临时访客'; password = 'tmp12345' } | Out-Null
    Api -Path '/api/me' -Session $SU | Out-Null
    $tmpId = (Api -Path '/api/me' -Session $SU).user.id
    $del = Api -Method DELETE -Path "/api/admin/visitors/$tmpId" -Session $SD
    $code = ApiStatus -Method DELETE -Path "/api/admin/visitors/$tmpId" -Session $SD
    $left = @((Api -Path '/api/admin/visitors' -Session $SD).items | Where-Object { $_.id -eq $tmpId }).Count
    $del.ok -eq $true -and $del.removed.visits -ge 1 -and $code -eq 404 -and $left -eq 0
  }

  # 收尾清理：删掉自检造出来的文档记录（连带它发上墙的回忆）
  foreach ($f in (Api -Path '/api/admin/monitor/files' -Session $SD).items) {
    if ($f.kind -eq 'post-doc') { Api -Method DELETE -Path "/api/admin/monitor/files/$($f.id)" -Session $SD | Out-Null }
  }
  Remove-Item $tmpDoc -Force -ErrorAction SilentlyContinue
  Remove-Item (Join-Path $env:TEMP 'mem-smoke-doc2.txt') -Force -ErrorAction SilentlyContinue
  Remove-Item (Join-Path $env:TEMP 'mem-smoke-bad.exe') -Force -ErrorAction SilentlyContinue
}


# ================= 5. 站名（后台能改前端学校名称） =================
Write-Host ""
Write-Host "-- 5) 站名 --" -ForegroundColor Cyan

Check '设置里有学校名称字段（默认廊坊一中）' {
  $s0 = (Api -Path '/api/admin/settings' -Session $SA).settings
  $s0.schoolName -eq '廊坊一中' -and $null -ne $s0.schoolEn
}
Check '改学校名、站点全称留空会自动派生' {
  $r = Api -Method POST -Path '/api/admin/settings' -Session $SA -Body @{ schoolName = '南开中学'; siteTitle = ''; schoolEn = 'NANKAI HIGH SCHOOL' }
  $r.settings.siteTitle -eq '南开中学回忆录'
}
Check '前台 /api/me 拿到新学校名与英文名' {
  $m = (Api -Path '/api/me').settings
  $m.schoolName -eq '南开中学' -and $m.schoolEn -eq 'NANKAI HIGH SCHOOL' -and $m.siteTitle -eq '南开中学回忆录'
}
Check '自己填的站点全称不会被学校名覆盖' {
  $r = Api -Method POST -Path '/api/admin/settings' -Session $SA -Body @{ siteTitle = '南开的夏天' }
  $r.settings.siteTitle -eq '南开的夏天' -and $r.settings.schoolName -eq '南开中学'
}
Check '学校名超长会被截断' {
  $r = Api -Method POST -Path '/api/admin/settings' -Session $SA -Body @{ schoolName = ('x' * 50) }
  $r.settings.schoolName.Length -eq 20
}
Check '恢复默认站名' {
  $r = Api -Method POST -Path '/api/admin/settings' -Session $SA -Body @{ schoolName = '廊坊一中'; siteTitle = '廊坊一中回忆录'; schoolEn = 'LANGFANG NO.1 MIDDLE SCHOOL' }
  $r.settings.siteTitle -eq '廊坊一中回忆录' -and $r.settings.schoolName -eq '廊坊一中'
}
Check '登录页大标题与页脚已接站名' {
  $i1 = (Invoke-WebRequest -UseBasicParsing "$Base/index.html").Content
  $w1 = (Invoke-WebRequest -UseBasicParsing "$Base/wall.html").Content
  $i1.Contains('data-school') -and $w1.Contains('data-site-foot')
}
Check '后台设置页有学校名称输入框和预览' {
  $a1 = (Invoke-WebRequest -UseBasicParsing "$Base/admin.html").Content
  $a1.Contains('id="s-school"') -and $a1.Contains('bp-school')
}
# ================= 汇总 =================
$color = if ($script:fail -eq 0) { 'Green' } else { 'Red' }
Write-Host "`n== 结果：通过 $script:pass 项，失败 $script:fail 项 ==" -ForegroundColor $color
if ($script:fail -gt 0) { exit 1 }
