--[[
  NEARBY Roblox server-side position publisher (starter).

  Put this Script in ServerScriptService.
  Enable Game Settings > Security > Allow HTTP Requests.
  Set the external server URL and shared secret below.

  IMPORTANT:
  - Never put the secret in a LocalScript.
  - Do not use localhost from a hosted Roblox server.
  - Deploy the Node server behind HTTPS before using it publicly.
  - This example sends player world positions to the dashboard server.
]]

local HttpService = game:GetService("HttpService")
local Players = game:GetService("Players")

local ENDPOINT = "https://YOUR-DOMAIN.example/roblox/update"
local SHARED_SECRET = "REPLACE_WITH_THE_SAME_LONG_SECRET_AS_SERVER"
local UPDATE_INTERVAL = 1.5

local function getServerId()
    return game.JobId
end

local function collectPlayers()
    local result = {}

    for _, player in ipairs(Players:GetPlayers()) do
        local character = player.Character
        local root = character and character:FindFirstChild("HumanoidRootPart")

        if root then
            local position = root.Position
            table.insert(result, {
                userId = player.UserId,
                name = player.Name,
                x = position.X,
                y = position.Y,
                z = position.Z
            })
        end
    end

    return result
end

local function publishPositions()
    local payload = {
        serverId = getServerId(),
        players = collectPlayers()
    }

    local success, response = pcall(function()
        return HttpService:RequestAsync({
            Url = ENDPOINT,
            Method = "POST",
            Headers = {
                ["Content-Type"] = "application/json",
                ["x-roblox-secret"] = SHARED_SECRET
            },
            Body = HttpService:JSONEncode(payload)
        })
    end)

    if not success then
        warn("[NEARBY] HTTP request failed:", response)
        return
    end

    if not response.Success then
        warn("[NEARBY] Server rejected update:", response.StatusCode, response.Body)
    end
end

while true do
    publishPositions()
    task.wait(UPDATE_INTERVAL)
end
