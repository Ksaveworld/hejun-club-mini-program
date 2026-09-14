function Invoke-ClubLocalHealth {
    param([Uri]$Uri, [int]$TimeoutSec = 3)
    if ($Uri.Scheme -ne 'http' -or $Uri.Host -notmatch '^(127\.0\.0\.1|10\.[0-9.]+|192\.168\.[0-9.]+|172\.(1[6-9]|2[0-9]|3[01])\.[0-9.]+)$') {
        throw '本机健康检查只允许访问回环或局域网 IPv4 地址。'
    }
    Add-Type -AssemblyName System.Net.Http
    $handler = [System.Net.Http.HttpClientHandler]::new()
    $handler.UseProxy = $false
    $client = [System.Net.Http.HttpClient]::new($handler)
    $client.Timeout = [TimeSpan]::FromSeconds($TimeoutSec)
    try { $client.GetStringAsync($Uri).GetAwaiter().GetResult() | ConvertFrom-Json }
    finally { $client.Dispose() }
}
