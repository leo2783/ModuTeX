
-- Persistent plain-text Draft frames. The Rust host converts accepted source
-- characters to trusted \char tokens; aux/bbl/fls are copied as data only.
local warm_frame = nil

-- TeX's terminal output can remain buffered while Lua blocks reading the
-- next frame. These protocol markers go directly to the inherited stdout
-- pipe and are flushed before the host waits for them.
local function warm_signal(marker)
    local stdout = io.stdout
    if not stdout then
        error("Draft warm protocol stdout is unavailable")
    end
    local wrote, write_error = stdout:write(marker, "\n")
    if not wrote then
        error("Draft warm protocol write failed: " .. tostring(write_error))
    end
    local flushed, flush_error = stdout:flush()
    if not flushed then
        error("Draft warm protocol flush failed: " .. tostring(flush_error))
    end
end

local function warm_valid_id(value)
    return type(value) == "string"
        and #value > 0
        and #value <= 128
        and value:match("^[A-Za-z0-9_%-]+$") ~= nil
end

local function warm_hex_decode(value, maximum)
    if type(value) ~= "string" or #value % 2 ~= 0 or #value > maximum * 2 then
        error("invalid bounded Draft warm encoding")
    end
    local output = {}
    for index = 1, #value, 2 do
        local byte = tonumber(value:sub(index, index + 1), 16)
        if not byte then
            error("invalid Draft warm hexadecimal input")
        end
        output[#output + 1] = string.char(byte)
    end
    return table.concat(output)
end

local function warm_write(path, bytes)
    local file, open_error = io.open(path, "wb")
    if not file then
        error("Draft warm output open failed: " .. tostring(open_error))
    end
    local wrote, write_error = file:write(bytes)
    local closed, close_error = file:close()
    if not wrote or not closed then
        error("Draft warm output write failed: "
            .. tostring(write_error or close_error))
    end
end

function modutex_draft_warm_text(encoded)
    if not warm_frame then
        error("Draft warm text arrived outside a frame")
    end
    local body = warm_hex_decode(encoded, 512 * 1024)
    -- This contains only host-generated \char<number> and \par tokens.
    if body:find("[^\\%a%d ]") then
        error("invalid host-generated Draft warm TeX")
    end
    tex.sprint(body)
end

function modutex_draft_warm_capture(id, box_index)
    local frame = warm_frame
    if not frame or frame.id ~= id then
        error("Draft warm frame identity mismatch")
    end
    local box = tex.box[box_index]
    if not box then
        error("Draft warm paragraph box is unavailable")
    end

    total_records = 0
    local page = {
        number = 1,
        widthPt = pt(dimension("pagewidth", dimension("paperwidth", 0))),
        heightPt = pt(dimension("pageheight", dimension("paperheight", 0))),
        baseline = nil,
        records = {},
        unsupported = {},
    }
    local left = 4736287 + dimension("hoffset", 0) + dimension("oddsidemargin", 0)
    local top = 4736287 + dimension("voffset", 0) + dimension("topmargin", 0)
        + dimension("headheight", 0) + dimension("headsep", 0)
    scan_list(box.list, left, top, true, 0, page)
    local text_height = dimension("textheight", 0)
    if text_height > 0 and box.height + box.depth > text_height then
        page.unsupported["warm-content-exceeds-text-height"] = true
    end
    page.shipoutBaselineHeightPt = pt(page.baseline or 0)
    page.unsupportedContentReasons = unsupported_list(page.unsupported)
    page.renderableRecords = page.records

    local output = '{"geometry":' .. geometry_json()
        .. ',"pages":' .. json_array({ page }, page_json) .. '}'
    local stem = tostring(tex.jobname or "draft") .. ".frame-" .. id
    warm_write(stem .. ".draft.json", output)
    warm_write(stem .. ".used.aux", frame.aux)
    warm_write(stem .. ".used.bbl", frame.bbl)
    warm_write(stem .. ".used.fls", frame.fls)
    warm_frame = nil

    warm_signal("MODUTEX_FRAME_DONE_" .. id)
    tex.sprint("\\endgroup\\directlua{modutex_draft_warm_next()}")
end

function modutex_draft_warm_next()
    local line = io.stdin:read("*l")
    if line == nil or line == "QUIT" then
        warm_signal("MODUTEX_WARM_STOP")
        tex.sprint("\\end{document}")
        return
    end
    if #line > 34 * 1024 * 1024 then
        error("Draft warm request exceeds its line bound")
    end
    local id, body_hex, aux_hex, bbl_hex, fls_hex =
        line:match("^([^|]+)|([^|]*)|([^|]*)|([^|]*)|([^|]*)$")
    if not warm_valid_id(id) or warm_frame then
        error("invalid or overlapping Draft warm frame")
    end
    local body = warm_hex_decode(body_hex, 512 * 1024)
    local aux = warm_hex_decode(aux_hex, 4 * 1024 * 1024)
    local bbl = warm_hex_decode(bbl_hex, 4 * 1024 * 1024)
    local fls = warm_hex_decode(fls_hex, 8 * 1024 * 1024)
    if body:find("[^\\%a%d ]") then
        error("invalid host-generated Draft warm TeX")
    end
    warm_frame = { id = id, aux = aux, bbl = bbl, fls = fls }
    local tokens = "\\begingroup\\setbox\\modutexdraftwarmbox=\\vbox{"
        .. "\\hsize=\\textwidth\\noindent"
        .. "\\directlua{modutex_draft_warm_text('" .. body_hex .. "')}"
        .. "\\par}"
        .. "\\directlua{modutex_draft_warm_capture('" .. id
        .. "',\\number\\modutexdraftwarmbox)}"
    tex.sprint(tokens)
end

function modutex_draft_warm_start()
    warm_signal("MODUTEX_WARM_READY")
    modutex_draft_warm_next()
end
