-- SPDX-License-Identifier: Apache-2.0
-- Original LuaLaTeX shipout extractor, embedded by the Rust host as a
-- packaged resource. It observes pages without changing or replacing the PDF.

local pages = {}
local page_count = 0
local total_records = 0
local max_pages = 1000
local max_records = 20000

local function dimension(name, fallback)
    local ok, value = pcall(function()
        return tex.dimen[name]
    end)
    if ok and type(value) == "number" then
        return value
    end
    return fallback or 0
end

local function pt(value)
    return math.floor((value or 0) / 65536 * 10000 + 0.5) / 10000
end

local function escape_json(value)
    local text = tostring(value or "")
    text = text:gsub("\\", "\\\\")
    text = text:gsub('"', '\\"')
    text = text:gsub("\b", "\\b")
    text = text:gsub("\f", "\\f")
    text = text:gsub("\n", "\\n")
    text = text:gsub("\r", "\\r")
    text = text:gsub("\t", "\\t")
    text = text:gsub("[%z\1-\31]", function(character)
        return string.format("\\u%04x", string.byte(character))
    end)
    return '"' .. text .. '"'
end

local function json_number(value)
    if type(value) ~= "number" or value ~= value or value == math.huge or value == -math.huge then
        return "0"
    end
    return string.format("%.4f", value)
end

local function json_array(values, encode)
    local output = {}
    for index, value in ipairs(values) do
        output[index] = encode(value)
    end
    return "[" .. table.concat(output, ",") .. "]"
end

local function unsupported_list(values)
    local output = {}
    for reason in pairs(values) do
        output[#output + 1] = reason
    end
    table.sort(output)
    return output
end

local function node_name(value)
    local ok, name = pcall(node.type, value)
    if ok and type(name) == "string" then
        return name
    end
    return "unknown"
end

local function glyph_text(codepoint)
    if type(utf8) == "table" and type(utf8.char) == "function" then
        local ok, value = pcall(utf8.char, codepoint)
        if ok then
            return value
        end
    end
    if codepoint >= 0 and codepoint < 128 then
        return string.char(codepoint)
    end
    return "?"
end

local function record_json(record)
    local text = record.text and escape_json(record.text) or "null"
    local font = record.fontId and tostring(record.fontId) or "null"
    return '{"kind":' .. escape_json(record.kind)
        .. ',"xPt":' .. json_number(record.xPt)
        .. ',"yPt":' .. json_number(record.yPt)
        .. ',"widthPt":' .. json_number(record.widthPt)
        .. ',"heightPt":' .. json_number(record.heightPt)
        .. ',"text":' .. text
        .. ',"fontId":' .. font .. '}'
end

local function page_json(page)
    return '{"number":' .. tostring(page.number)
        .. ',"widthPt":' .. json_number(page.widthPt)
        .. ',"heightPt":' .. json_number(page.heightPt)
        .. ',"shipoutBaselineHeightPt":' .. json_number(page.shipoutBaselineHeightPt)
        .. ',"unsupportedContentReasons":'
        .. json_array(page.unsupportedContentReasons, escape_json)
        .. ',"renderableRecords":'
        .. json_array(page.renderableRecords, record_json) .. '}'
end

local function scan_list(head, x, y, vertical, depth, page)
    if not head or depth > 32 then
        if depth > 32 then
            page.unsupported["nested-box-depth-limit"] = true
        end
        return
    end

    local cursor_x = x
    local cursor_y = y
    for current in node.traverse(head) do
        local kind = node_name(current.id)
        local width = current.width or 0
        local height = current.height or 0
        local node_depth = current.depth or 0

        if kind == "glyph" then
            if total_records < max_records then
                total_records = total_records + 1
                page.records[#page.records + 1] = {
                    kind = "glyph",
                    xPt = pt(cursor_x),
                    yPt = pt(cursor_y + height),
                    widthPt = pt(width),
                    heightPt = pt(height + node_depth),
                    text = glyph_text(current.char or 0),
                    fontId = current.font,
                }
            else
                page.unsupported["renderable-record-limit"] = true
            end
            if not vertical then
                cursor_x = cursor_x + width
            end
        elseif kind == "rule" then
            if total_records < max_records then
                total_records = total_records + 1
                page.records[#page.records + 1] = {
                    kind = "rule",
                    xPt = pt(cursor_x),
                    yPt = pt(cursor_y),
                    widthPt = pt(width),
                    heightPt = pt(height + node_depth),
                }
            else
                page.unsupported["renderable-record-limit"] = true
            end
            if vertical then
                cursor_y = cursor_y + height + node_depth
            else
                cursor_x = cursor_x + width
            end
        elseif kind == "hlist" or kind == "vlist" then
            if kind == "hlist" and page.baseline == nil then
                page.baseline = cursor_y + height
            end
            scan_list(
                current.list,
                cursor_x,
                cursor_y,
                kind == "vlist",
                depth + 1,
                page
            )
            if vertical then
                cursor_y = cursor_y + height + node_depth
            else
                cursor_x = cursor_x + width
            end
        elseif kind == "glue" or kind == "kern" or kind == "margin_kern" then
            local advance = current.width or current.kern or 0
            if vertical then
                cursor_y = cursor_y + advance
            else
                cursor_x = cursor_x + advance
            end
        elseif kind == "penalty" or kind == "dir" or kind == "local_par" then
            -- These nodes affect TeX layout but have no independent painted
            -- representation in the extracted page records.
        else
            page.unsupported["unsupported-node-" .. kind] = true
            if kind == "whatsit" and current.subtype then
                page.unsupported["whatsit-subtype-" .. tostring(current.subtype)] = true
            end
        end
    end
end

local function capture_shipout(head)
    local ok, result = pcall(function()
        page_count = page_count + 1
        if page_count > max_pages then
            return head
        end
        local page = {
            number = page_count,
            widthPt = pt(dimension("pagewidth", dimension("paperwidth", 0))),
            heightPt = pt(dimension("pageheight", dimension("paperheight", 0))),
            baseline = nil,
            records = {},
            unsupported = {},
        }
        local list = head
        if head and head.list then
            list = head.list
        end
        scan_list(list, 0, 0, true, 0, page)
        page.shipoutBaselineHeightPt = pt(page.baseline or 0)
        page.unsupportedContentReasons = unsupported_list(page.unsupported)
        page.renderableRecords = page.records
        pages[#pages + 1] = page
        return head
    end)
    if not ok then
        texio.write_nl("term and log", "ModuTeX Draft shipout extraction was incomplete.")
        return head
    end
    return result
end

local function geometry_json()
    local paper_width = dimension("paperwidth", dimension("pagewidth", 0))
    local paper_height = dimension("paperheight", dimension("pageheight", 0))
    local left = 4736287 + dimension("oddsidemargin", 0)
    local top = 4736287 + dimension("topmargin", 0)
    local column = dimension("columnwidth", dimension("hsize", 0))
    local foot = dimension("footskip", 0)
    local text_height = dimension("textheight", 0)
    local right = math.max(0, paper_width - left - column)
    local bottom = math.max(0, paper_height - top - text_height)
    return '{"paperWidthPt":' .. json_number(pt(paper_width))
        .. ',"paperHeightPt":' .. json_number(pt(paper_height))
        .. ',"columnWidthPt":' .. json_number(pt(column))
        .. ',"footSkipPt":' .. json_number(pt(foot))
        .. ',"marginLeftPt":' .. json_number(pt(math.max(0, left)))
        .. ',"marginRightPt":' .. json_number(pt(right))
        .. ',"marginTopPt":' .. json_number(pt(math.max(0, top)))
        .. ',"marginBottomPt":' .. json_number(pt(bottom)) .. '}'
end

local function write_records()
    local filename = tostring(tex.jobname or "draft") .. ".draft.json"
    local output = '{"geometry":' .. geometry_json()
        .. ',"pages":' .. json_array(pages, page_json) .. '}'
    local ok, file = pcall(io.open, filename, "wb")
    if not ok or not file then
        texio.write_nl("term and log", "ModuTeX Draft could not write shipout records.")
        return
    end
    local wrote = pcall(function()
        file:write(output)
        file:close()
    end)
    if not wrote then
        pcall(function()
            file:close()
        end)
        texio.write_nl("term and log", "ModuTeX Draft shipout record write was incomplete.")
    end
end

local function add_callback(name, callback_function, description)
    if type(luatexbase) == "table" and type(luatexbase.add_to_callback) == "function" then
        luatexbase.add_to_callback(name, callback_function, description)
    else
        callback.register(name, callback_function)
    end
end

add_callback("pre_shipout_filter", capture_shipout, "modutex-draft-shipout-records")
add_callback("stop_run", write_records, "modutex-draft-write-records")
