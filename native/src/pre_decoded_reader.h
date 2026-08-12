#pragma once

#include <cstdint>
#include <cstring>
#include <vector>

// OpenBW's replay_functions::load_replay(reader_T&& r, ...) is a template that only
// needs a reader exposing:
//   - r.template get<uint32_t>()   (called 3x, in this exact order: identifier, then
//                                    actions-buffer size, then map-buffer size)
//   - r.get_bytes(uint8_t* out, size_t n)  (called 3x: header (fixed 633 bytes),
//                                            actions data, map data)
//
// We don't feed it raw file bytes - the file's container format (checksummed,
// zlib-compressed, chunked sections) is decoded ahead of time in Node (see
// bw-companion/src/replayContainer.js), which is also what independently validates that
// this is really an SC:R replay before we ever get here. So this reader just serves
// already-decompressed buffers back in the fixed call order load_replay() uses, and
// exists purely to satisfy OpenBW's reader interface without modifying OpenBW's code.
struct pre_decoded_reader {
	const std::vector<uint8_t>& header;
	const std::vector<uint8_t>& commands;
	const std::vector<uint8_t>& map;

	int scalar_call_index = 0;
	int bytes_call_index = 0;

	pre_decoded_reader(const std::vector<uint8_t>& header, const std::vector<uint8_t>& commands, const std::vector<uint8_t>& map)
		: header(header), commands(commands), map(map) {}

	template<typename T, bool little_endian = true>
	T get() {
		static_assert(std::is_same<T, uint32_t>::value, "pre_decoded_reader only expects uint32_t scalar reads");
		switch (scalar_call_index++) {
		case 0: return (uint32_t)0x53526572u; // identifier shim; already validated upstream in Node
		case 1: return (uint32_t)commands.size();
		case 2: return (uint32_t)map.size();
		default:
			fprintf(stderr, "pre_decoded_reader: unexpected extra scalar read\n");
			std::terminate();
		}
	}

	void get_bytes(uint8_t* output, size_t output_size) {
		const std::vector<uint8_t>* src = nullptr;
		switch (bytes_call_index++) {
		case 0: src = &header; break;
		case 1: src = &commands; break;
		case 2: src = &map; break;
		default:
			fprintf(stderr, "pre_decoded_reader: unexpected extra get_bytes call\n");
			std::terminate();
		}
		if (src->size() != output_size) {
			fprintf(stderr, "pre_decoded_reader: size mismatch (have %zu, want %zu)\n", src->size(), output_size);
			std::terminate();
		}
		memcpy(output, src->data(), output_size);
	}
};
