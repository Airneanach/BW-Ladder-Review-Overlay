#pragma once

// StarCraft: Remastered's modern client stores game data in Blizzard's CASC storage
// format (Data/config, Data/data, Data/indices), not the classic loose .mpq files
// OpenBW's own data loader (data_loading.h's data_files_directory/mpq_file) expects.
// OpenBW's game_player::init() is templated on the loader callable though, so instead
// of feeding it real .mpq files, we supply our own loader here that reads the same
// named data files (e.g. "arr/units.dat") directly out of CASC storage via CascLib
// (https://github.com/ladislav-zezula/CascLib, MIT licensed).

// We compile CascLib's source directly into this binary (see sources-c.c/sources-cpp.cpp
// in the vendored copy) rather than linking a prebuilt CascLib.lib, so suppress CascLib.h's
// auto-link pragma for a prebuilt library that doesn't exist here.
#define CASCLIB_NO_AUTO_LINK_LIBRARY
#include "CascLib.h"

#include <stdexcept>
#include <string>
#include <vector>

struct casc_data_loader {
	void* storage_handle = nullptr;

	explicit casc_data_loader(const std::string& install_path) {
		if (!CascOpenStorage(install_path.c_str(), 0, &storage_handle)) {
			throw std::runtime_error("CascOpenStorage failed for '" + install_path + "' (error " + std::to_string(GetLastError()) + ")");
		}
	}
	casc_data_loader(const casc_data_loader&) = delete;
	casc_data_loader(casc_data_loader&& other) noexcept {
		storage_handle = other.storage_handle;
		other.storage_handle = nullptr;
	}
	~casc_data_loader() {
		if (storage_handle) CascCloseStorage(storage_handle);
	}

	void operator()(std::vector<uint8_t>& dst, std::string filename) {
		for (auto& c : filename) {
			if (c == '/') c = '\\';
		}
		void* file_handle = nullptr;
		if (!CascOpenFile(storage_handle, filename.c_str(), 0, 0, &file_handle)) {
			throw std::runtime_error("CascOpenFile failed for '" + filename + "' (error " + std::to_string(GetLastError()) + ")");
		}
		unsigned long long size = 0;
		CascGetFileSize64(file_handle, &size);
		dst.resize((size_t)size);
		unsigned long bytes_read = 0;
		bool ok = CascReadFile(file_handle, dst.data(), (unsigned long)size, &bytes_read);
		CascCloseFile(file_handle);
		if (!ok || bytes_read != size) {
			throw std::runtime_error("CascReadFile failed for '" + filename + "'");
		}
	}
};
