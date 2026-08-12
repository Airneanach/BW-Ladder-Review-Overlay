#ifndef BWGAME_ACTIONS_H
#define BWGAME_ACTIONS_H

#include "bwgame.h"

namespace bwgame {

struct action_state {
	action_state() = default;
	action_state(const action_state&) = delete;
	action_state(action_state&&) = default;
	action_state& operator=(const action_state&) = delete;
	action_state& operator=(action_state&&) = default;

	std::array<int, 12> player_id{};

	size_t actions_data_position = 0;
	int next_action_frame = 0;

	std::array<static_vector<unit_t*, 12>, 8> selection{};
	std::array<std::array<static_vector<unit_id, 12>, 10>, 8> control_groups{};

	// Diagnostics only - not game state, not copied by copy_state below.
	// Counts how often an extended-command unit tag failed to resolve to a live
	// unit. A rising failure rate is the signature of kExtUnitTagOffset (see the
	// long comment on it in action_functions) having drifted out of alignment
	// with the real client's unit table, which manifests as commands silently
	// doing nothing rather than as any kind of error. bwlive.cpp reports these
	// so a live game can be flagged as untrustworthy instead of quietly
	// rendering wrong production.
	size_t ext_tag_lookups = 0;
	size_t ext_tag_failures = 0;

	// Diagnostics only. Scores every candidate interpretation of an extended
	// command's unit tag against the live unit table, so the right one can be
	// picked from evidence instead of argued about. `owned` is the signal that
	// matters: a player can only select their own units, so a decoding that
	// resolves to a live unit belonging to the issuing player is almost
	// certainly correct, while one resolving to a live unit owned by someone
	// else is landing on the wrong unit. Enabled by bwlive.exe --tag-probe.
	struct tag_probe_t {
		size_t live = 0;
		size_t owned = 0;
	};
	static constexpr size_t tag_probe_count = 10;
	std::array<tag_probe_t, tag_probe_count> tag_probe{};
	size_t tag_probe_total = 0;
	bool tag_probe_enabled = false;

	// Same scores again, bucketed by two minutes of game time. A decoding that
	// is simply wrong scores badly from frame 0; one that is right but whose
	// slot numbering drifts out of step with the real client scores well early
	// and decays. Those need telling apart.
	static constexpr size_t tag_probe_buckets = 20;
	static constexpr int tag_probe_bucket_frames = 2857; // ~2 minutes at 23.81 fps
	std::array<std::array<tag_probe_t, tag_probe_count>, tag_probe_buckets> tag_probe_by_time{};
	std::array<size_t, tag_probe_buckets> tag_probe_by_time_total{};
};

static inline action_state copy_state(const action_state& action_st, const state& source_st, const state& dest_st) {
	action_state r;
	r.player_id = action_st.player_id;
	r.actions_data_position = action_st.actions_data_position;
	r.next_action_frame = action_st.next_action_frame;
	r.selection = action_st.selection;
	for (auto& v : r.selection) {
		for (auto& v2 : v) {
			v2 = const_cast<unit_t*>(dest_st.units_container.at(v2->index));
		}
	}
	r.control_groups = action_st.control_groups;
	return r;
}

struct action_functions: state_functions {
	action_state& action_st;
	explicit action_functions(state& st, action_state& action_st) : state_functions(st), action_st(action_st) {}

	bool unit_can_be_multi_selected(const unit_t* u) const {
		if (ut_building(u)) return false;
		if (ut_flag(u, (unit_type_t::flags_t)0x800)) return false;
		if (unit_is_disabled(u)) return false;
		auto tid = u->unit_type->id;
		if (tid >= UnitTypes::Special_Floor_Missile_Trap && tid <= UnitTypes::Special_Right_Wall_Flame_Trap) return false;
		if (tid == UnitTypes::Terran_Vulture_Spider_Mine) return false;
		if (tid == UnitTypes::Zerg_Egg) return false;
		if (tid == UnitTypes::Critter_Rhynadon) return false;
		if (tid == UnitTypes::Critter_Bengalaas) return false;
		if (tid == UnitTypes::Critter_Scantid) return false;
		if (tid == UnitTypes::Critter_Kakaru) return false;
		if (tid == UnitTypes::Critter_Ragnasaur) return false;
		if (tid == UnitTypes::Critter_Ursadon) return false;
		if (tid == UnitTypes::Spell_Dark_Swarm) return false;
		if (tid == UnitTypes::Spell_Disruption_Web) return false;
		return true;
	}

	auto selected_units(int owner) const {
		return make_filter_range(action_st.selection.at(owner), [this](unit_t* u) {
			return u && !unit_dead(u);
		});
	}

	auto control_group(int owner, size_t group_n) const {
		return make_filter_range(make_transform_range(action_st.control_groups.at(owner).at(group_n), [this](unit_id u) {
			return get_unit(u);
		}), [](unit_t* u) {
			return u != nullptr;
		});
	}

	unit_t* get_first_selected_unit(int owner) const {
		for (unit_t* u : selected_units(owner)) {
			return u;
		}
		return nullptr;
	}

	unit_t* get_single_selected_unit(int owner) const {
		auto sel = selected_units(owner);
		if (sel.empty()) return nullptr;
		auto i = sel.begin();
		if (std::next(i) != sel.end()) return nullptr;
		return *i;
	}

	virtual void on_unit_deselect(unit_t* u) override {
		for (size_t i = 0; i != 8; ++i) {
			auto& selection = action_st.selection.at(i);
			auto it = std::find(selection.begin(), selection.end(), u);
			if (it != selection.end()) selection.erase(it);
		}
	}

	struct group_move_t {
		xy original_target_pos;
		xy target_pos;
		xy move_offset;
		bool has_move_offset;
		bool target_is_in_unit_bounds;
	};

	void calc_group_move(group_move_t& g, int owner, xy target_pos, bool can_be_obstructed) {
		g.original_target_pos = target_pos;
		g.has_move_offset = false;
		g.target_is_in_unit_bounds = false;

		rect area{{std::numeric_limits<int>::max(), std::numeric_limits<int>::max()}, {0, 0}};
		bool any_collision_enabled_units = false;
		size_t n_units = 0;
		xy sum_pos;
		unsigned units_area = 0;
		for (const unit_t* u : selected_units(owner)) {
			++n_units;
			if (u->pathing_flags & 1) any_collision_enabled_units = true;
			xy pos = u->sprite->position;
			if (pos.x < area.from.x) area.from.x = pos.x;
			if (pos.y < area.from.y) area.from.y = pos.y;
			if (pos.x > area.to.x) area.to.x = pos.x;
			if (pos.y > area.to.y) area.to.y = pos.y;
			sum_pos += pos;
			int w = u->unit_type->dimensions.from.x + u->unit_type->dimensions.to.x + 1;
			int h = u->unit_type->dimensions.from.y + u->unit_type->dimensions.to.y + 1;
			units_area += w * h;
		}
		if (n_units == 0) return;

		if (any_collision_enabled_units && can_be_obstructed) {
			auto find_target = [&](rect bb, xy source_pos) {
				auto* source_region = get_region_at_prefer_walkable(source_pos);
				auto* target_region = get_region_at_prefer_walkable(target_pos);
				if (!is_walkable(target_pos) || source_region->group_index != target_region->group_index) {
					pathfinder pf;
					if (pathfinder_find_long_path(pf, source_pos, target_pos)) target_region = pf.long_path.back();
				}
				target_pos = pathfinder_adjust_destination(target_region, target_pos);
				target_pos = pathfinder_adjust_target_pos(bb, target_pos).second;
			};

			if (n_units == 1) {
				unit_t* u = get_first_selected_unit(owner);
				if (!unit_type_can_fit_at(u->unit_type, target_pos)) {
					const unit_t* u = *selected_units(owner).begin();
					find_target(unit_type_inner_bounding_box(u->unit_type), u->sprite->position);
				}
			} else {
				int units_area_square_width = isqrt(units_area * 2);
				if (!rectangle_can_fit_at(target_pos, units_area_square_width, units_area_square_width)) {
					rect bb;
					bb.from.x = -units_area_square_width / 2;
					bb.from.y = -units_area_square_width / 2;
					bb.to.x = bb.from.x + units_area_square_width;
					bb.to.y = bb.from.y + units_area_square_width;
					find_target(bb, sum_pos / (int)n_units);
				}
			}
			target_pos = restrict_pos_to_map_bounds(target_pos);
		}
		if (n_units >= 2) {
			if (is_in_inner_bounds(g.original_target_pos, area)) {
				g.target_is_in_unit_bounds = true;
				g.move_offset = {};
			} else if (any_collision_enabled_units) {
				if (area.to.x - area.from.x <= 192 && area.to.y - area.from.y <= 192) {
					g.move_offset = g.original_target_pos - sum_pos / (int)n_units;
					g.has_move_offset = true;
				}
			} else {
				if (area.to.x - area.from.x <= 256 && area.to.y - area.from.y <= 256) {
					g.move_offset = g.original_target_pos - sum_pos / (int)n_units;
					g.has_move_offset = true;
				}
			}
		}

		g.target_pos = target_pos;
	}

	xy get_group_move_pos(const unit_t* u, xy pos, const group_move_t& g) const {
		xy target_pos = u->pathing_flags & 1 ? g.target_pos : g.original_target_pos;
		if (g.target_is_in_unit_bounds) {
			pos = u->sprite->position;
			if (pos.x <= target_pos.x - 32) {
				pos.x = target_pos.x - 32;
			} else if (pos.x >= target_pos.x + 32) {
				pos.x = target_pos.x + 32;
			}
			if (pos.y <= target_pos.y - 32) {
				pos.y = target_pos.y - 32;
			} else if (pos.y >= target_pos.y + 32) {
				pos.y = target_pos.y + 32;
			}
		} else {
			if (g.has_move_offset) {
				pos.x = u->sprite->position.x + g.move_offset.x;
				pos.y = u->sprite->position.y + g.move_offset.y;
			}
		}

		pos = restrict_move_target_to_valid_bounds(u, pos);
		if (~u->pathing_flags & 1) return pos;
		auto* source_region = get_region_at(target_pos);
		if (unit_type_can_fit_at(u->unit_type, pos)) {
			auto* pos_region = get_region_at(pos);
			if (pos_region == source_region) return pos;
			for (auto* n : source_region->walkable_neighbors) {
				if (n == pos_region) return pos;
			}
		}
		int distance_to_target = xy_length(target_pos - pos);
		if (distance_to_target == 0) distance_to_target = 1;
		int step_distance = std::min(distance_to_target / 4, 16);
		if (step_distance < 2) step_distance = distance_to_target;
		for (int distance = step_distance; distance <= distance_to_target; distance += step_distance) {
			xy npos = pos + (target_pos - pos) * distance / distance_to_target;
			if (unit_type_can_fit_at(u->unit_type, npos)) {
				auto* npos_region = get_region_at(npos);
				if (npos_region == source_region) return npos;
				for (auto* n : source_region->walkable_neighbors) {
					if (n == npos_region) return npos;
				}
			}
		}
		return target_pos;
	}
	
	bool morph_archon_impl(int owner, bool is_dark_archon) {
		auto sel = selected_units(owner);
		auto i = sel.begin();
		if (i == sel.end()) return false;
		if (!unit_can_use_tech(*i, get_tech_type(is_dark_archon ? TechTypes::Dark_Archon_Meld : TechTypes::Archon_Warp), owner)) return false;
		bool retval = false;
		static_vector<unit_t*, 12> units;
		for (;i != sel.end(); ++i) {
			unit_t* u = *i;
			if (unit_is(u, is_dark_archon ? UnitTypes::Protoss_Dark_Templar : UnitTypes::Protoss_High_Templar)) units.push_back(u);
		}
		if (units.size() < 2) return false;
		for (size_t index = 0; index != units.size(); ++index) {
			unit_t* u = units[index];
			if (!u) continue;
			int nearest_distance = std::numeric_limits<int>::max();
			unit_t* nearest_unit = nullptr;
			for (size_t index2 = index + 1; index2 != units.size(); ++index2) {
				unit_t* u2 = units[index2];
				if (!u2) continue;
				xy relpos = u->sprite->position - u2->sprite->position;
				int d = relpos.x * relpos.x + relpos.y * relpos.y;
				if (d < nearest_distance) {
					units[index2] = nearest_unit;
					nearest_distance = d;
					nearest_unit = u2;
				}
			}
			if (!nearest_unit) continue;
			set_unit_order(u, get_order_type(is_dark_archon ? Orders::DarkArchonMeld : Orders::ArchonWarp), nearest_unit);
			set_unit_order(nearest_unit, get_order_type(is_dark_archon ? Orders::DarkArchonMeld : Orders::ArchonWarp), u);
			retval = true;
		}
		return retval;
	}

	template<typename units_T>
	bool action_select(int owner, units_T&& units) {
		auto& selection = action_st.selection.at(owner);
		selection.clear();
		bool retval = false;
		for (unit_t* u : units) {
			if (u && u->unit_type->id != UnitTypes::Terran_Nuclear_Missile) {
				if (std::find(selection.begin(), selection.end(), u) == selection.end()) {
					if (!us_hidden(u) && (selection.empty() || unit_can_be_multi_selected(u))) {
						if (selection.size() == 12) error("action_select: attempt to select more than 12 units");
						selection.push_back(u);
						retval = true;
					}
				}
			}
		}
		return retval;
	}

	bool action_select(int owner, unit_t* u) {
		return action_select(owner, std::array<unit_t*, 1>{u});
	}

	template<typename units_T>
	bool action_shift_select(int owner, units_T&& units) {
		auto& selection = action_st.selection.at(owner);
		if (selection.size() + units.size() > 12) return false;
		bool retval = false;
		for (unit_t* u : units) {
			if (u) {
				if (std::find(selection.begin(), selection.end(), u) == selection.end()) {
					if (!us_hidden(u) && (selection.empty() || unit_can_be_multi_selected(u))) {
						if (selection.size() == 12) error("action_shift_select: attempt to select more than 12 units");
						selection.push_back(u);
						retval = true;
					}
				}
			}
		}
		return retval;
	}

	bool action_shift_select(int owner, unit_t* u) {
		return action_shift_select(owner, std::array<unit_t*, 1>{u});
	}

	template<typename units_T>
	bool action_deselect(int owner, units_T&& units) {
		auto& selection = action_st.selection.at(owner);
		bool retval = false;
		for (unit_t* u : units) {
			if (u) {
				auto i = std::find(selection.begin(), selection.end(), u);
				if (i != selection.end()) {
					selection.erase(i);
					retval = true;
				}
			}
		}
		return retval;
	}

	bool action_deselect(int owner, unit_t* u) {
		return action_deselect(owner, std::array<unit_t*, 1>{u});
	}

	bool action_train(int owner, const unit_type_t* unit_type) {
		unit_t* u = get_single_selected_unit(owner);
		if (!u) return false;
		if (u->owner != owner) return false;
		if (!unit_can_build(u, unit_type)) return false;
		if (unit_type->id > UnitTypes::Spell_Disruption_Web) return false;
		if (!build_queue_push(u, unit_type)) return false;
		set_secondary_order(u, get_order_type(Orders::Train));
		return true;
	}

	bool action_build(int owner, const order_type_t* order_type, const unit_type_t* unit_type, xy_t<size_t> tile_pos) {
		unit_t* u = get_single_selected_unit(owner);
		if (!u) return false;
		if (u->owner != owner) return false;
		if (!unit_build_order_valid(u, order_type, unit_type, owner)) return false;
		if (ut_addon(unit_type)) {
			xy pos(int(32 * tile_pos.x) + unit_type->placement_size.x / 2, int(32 * tile_pos.y) + unit_type->placement_size.y / 2);
			if (can_place_building(u, owner, unit_type, pos, false, false)) {
				xy builder_pos(int(32 * tile_pos.x + u->unit_type->placement_size.x / 2), int(32 * tile_pos.y + u->unit_type->placement_size.y / 2));
				builder_pos.x -= unit_type->addon_position.x / 32 * 32;
				builder_pos.y -= unit_type->addon_position.y / 32 * 32;
				if (can_place_building(u, owner, u->unit_type, builder_pos, false, false)) {
					place_building(u, order_type, unit_type, builder_pos);
				}
			}
		} else {
			xy pos(int(32 * tile_pos.x) + unit_type->placement_size.x / 2, int(32 * tile_pos.y) + unit_type->placement_size.y / 2);
			if (can_place_building(u, owner, unit_type, pos, false, false)) {
				place_building(u, order_type, unit_type, pos);
			}
		}
		return true;
	}

	bool action_default_order(int owner, xy pos, unit_t* target, const unit_type_t* target_unit_type, bool queue) {
		if (!is_in_map_bounds(pos)) return false;
		if (target) target_unit_type = nullptr;
		else if (target_unit_type) {
			if (player_position_is_visible(owner, pos)) {
				target = find_unit_noexpand({pos - xy(96, 96), pos + xy(96, 96)}, [&](unit_t* n) {
					if (n->unit_type != target_unit_type) return false;
					if (n->sprite->position.x + n->unit_type->placement_size.x / 2 - (unsigned)pos.x >= (unsigned)n->unit_type->placement_size.x) return false;
					if (n->sprite->position.y + n->unit_type->placement_size.y / 2 - (unsigned)pos.y >= (unsigned)n->unit_type->placement_size.y) return false;
					return true;
				});
				target_unit_type = nullptr;
			}
		}
		group_move_t g;
		bool has_calculated_group_move = false;
		bool retval = false;
		for (unit_t* u : selected_units(owner)) {
			const order_type_t* order = get_default_order(default_action(u), u, pos, target, target_unit_type);
			if (order) {
				if (order->id == Orders::RallyPointUnit) {
					if (unit_is_factory(u)) {
						retval = true;
						if (!target) target = u;
						u->building.rally.unit = target;
						u->building.rally.pos = target->sprite->position;
					}
				} else if (target != u) {
					if (order->id == Orders::RallyPointTile) {
						if (unit_is_factory(u)) {
							retval = true;
							u->building.rally.unit = nullptr;
							u->building.rally.pos = pos;
						}
					} else {
						if (order->id == Orders::AttackDefault) {
							if (u->subunit) {
								issue_order(u->subunit, queue, u->subunit->unit_type->attack_unit, target);
							}
							order = u->unit_type->attack_unit;
						}
						if (unit_can_receive_order(u, order, owner)) {
							retval = true;
							if (target) {
								order_target_t order_target;
								order_target.unit = target;
								issue_order(u, queue, order, order_target);
							} else {
								order_target_t order_target;
								order_target.position = pos;
								order_target.unit_type = target_unit_type;
								if (!target_unit_type) {
									if (!has_calculated_group_move) {
										has_calculated_group_move = true;
										calc_group_move(g, owner, pos, true);
									}
									order_target.position = get_group_move_pos(u, pos, g);
								}
								issue_order(u, queue, order, order_target);
							}
							u->user_action_flags |= 2;
						}
					}
				}

			}
		}
		return retval;
	}

	bool action_order(int owner, const order_type_t* input_order, xy pos, unit_t* target, const unit_type_t* target_unit_type, bool queue) {
		if (!is_in_map_bounds(pos)) return false;
		switch (input_order->id) {
		case Orders::Die:
		case Orders::InfestedCommandCenter:
		case Orders::SpiderMine:
		case Orders::DroneStartBuild:
		case Orders::InfestingCommandCenter:
		case Orders::PlaceBuilding:
		case Orders::PlaceProtossBuilding:
		case Orders::CreateProtossBuilding:
		case Orders::ConstructingBuilding:
		case Orders::PlaceAddon:
		case Orders::BuildNydusExit:
		case Orders::BuildingLand:
		case Orders::BuildingLiftoff:
		case Orders::DroneLiftOff:
		case Orders::Harvest2:
		case Orders::MoveToGas:
		case Orders::WaitForGas:
		case Orders::HarvestGas:
		case Orders::MoveToMinerals:
		case Orders::WaitForMinerals:
		case Orders::MiningMinerals:
		case Orders::GatheringInterrupted:
		case Orders::GatherWaitInterrupted:
		case Orders::CTFCOP2:
			return false;
		default:
			break;
		}
		bool can_be_obstructed = input_order->can_be_obstructed;
		group_move_t g;
		bool has_calculated_group_move = false;
		bool retval = false;
		for (unit_t* u : selected_units(owner)) {
			const order_type_t* order = input_order;
			if (order->tech_type == TechTypes::None) {
				if (!unit_can_receive_order(u, order, owner)) continue;
			} else {
				if (!unit_can_use_tech(u, get_tech_type(order->tech_type), owner)) continue;
			}
			if (u == target) {
				if (!unit_order_can_target_self(u, order)) continue;
			}
			if (u->order_type->id == Orders::NukeLaunch) continue;
			if (default_action(u) == 0) {
				auto oid = order->id;
				if (oid != Orders::RallyPointUnit && oid != Orders::RallyPointTile && oid != Orders::RechargeShieldsBattery && oid != Orders::PickupBunker) continue;
			}
			if (unit_is(u, UnitTypes::Terran_Medic)) {
				if (order->id == Orders::AttackMove || order->id == Orders::AttackDefault) {
					order = get_order_type(Orders::HealMove);
				}
			}
			const order_type_t* subunit_order = get_order_type(Orders::Nothing);
			if (order->id == Orders::AttackDefault) {
				if (target) order = u->unit_type->attack_unit;
				else order = u->unit_type->attack_move;
				if (order->id == Orders::Nothing) continue;
				if (u->subunit) {
					if (target) subunit_order = u->subunit->unit_type->attack_unit;
					else subunit_order = u->subunit->unit_type->attack_move;
				}
			}
			if (order->id == Orders::RallyPointUnit) {
				if (unit_is_factory(u)) {
					retval = true;
					if (!target) target = u;
					u->building.rally.unit = target;
					u->building.rally.pos = target->sprite->position;
				}
				u->user_action_flags |= 2;
			} else if (order->id == Orders::RallyPointTile) {
				if (unit_is_factory(u)) {
					retval = true;
					u->building.rally.unit = nullptr;
					u->building.rally.pos = pos;
				}
				u->user_action_flags |= 2;
			} else {
				retval = true;
				if (target) {
					order_target_t order_target;
					order_target.unit = target;
					issue_order(u, queue, order, order_target);
					if (subunit_order->id != Orders::Nothing) issue_order(u->subunit, queue, subunit_order, order_target);
				} else {
					order_target_t order_target;
					order_target.position = pos;
					order_target.unit_type = target_unit_type;
					if (!target_unit_type) {
						if (!has_calculated_group_move) {
							has_calculated_group_move = true;
							calc_group_move(g, owner, pos, can_be_obstructed);
						}
						order_target.position = get_group_move_pos(u, pos, g);
					}
					issue_order(u, queue, order, order_target);
					if (subunit_order->id != Orders::Nothing) issue_order(u->subunit, queue, subunit_order, order_target);
				}
				u->user_action_flags |= 2;
			}
		}
		return retval;
	}

	bool action_stop(int owner, bool queue) {
		bool retval = false;
		for (unit_t* u : selected_units(owner)) {
			if (unit_can_receive_order(u, get_order_type(Orders::Stop), owner)) {
				retval = true;
				issue_order(u, queue, get_order_type(Orders::Stop), {});
			}
		}
		return retval;
	}

	bool action_cancel_building_unit(int owner) {
		unit_t* u = get_single_selected_unit(owner);
		if (!u || u->owner != owner) return false;
		cancel_building_unit(u);
		return true;
	}

	bool action_cancel_build_queue(int owner, size_t slot) {
		unit_t* u = get_single_selected_unit(owner);
		if (!u || u->owner != owner) return false;
		if (!u_completed(u)) return false;
		if (unit_is(u, UnitTypes::Zerg_Larva)) return false;
		if (unit_is(u, UnitTypes::Zerg_Mutalisk)) return false;
		if (unit_is(u, UnitTypes::Zerg_Hydralisk)) return false;
		if (unit_is(u, UnitTypes::Zerg_Hatchery)) return false;
		if (unit_is(u, UnitTypes::Zerg_Lair)) return false;
		if (unit_is(u, UnitTypes::Zerg_Spire)) return false;
		if (unit_is(u, UnitTypes::Zerg_Creep_Colony)) return false;
		if (u->build_queue.empty()) return false;
		if (slot == 254) slot = u->build_queue.size() - 1;
		if (slot >= u->build_queue.size()) return false;
		cancel_build_queue(u, slot);
		return true;
	}

	bool action_control_group(int owner, size_t group_n, int subaction) {
		if (group_n >= 10) return false;
		bool retval = false;
		if (subaction == 1) {
			auto& group = action_st.control_groups.at(owner).at(group_n);
			if (!group.empty()) {
				auto& selection = action_st.selection.at(owner);
				selection.clear();
				for (size_t i = 0; i != group.size(); ++i) {
					unit_t* u = get_unit(group[i]);
					if (u && !us_hidden(u) && u->owner == owner && (group.size() == 1 || unit_can_be_multi_selected(u))) {
						selection.push_back(u);
						retval = true;
					} else {
						if (i != group.size() - 1) std::swap(group[i], group[group.size() - 1]);
						group.pop_back();
						--i;
					}
				}
			}
		} else if (subaction == 0 || subaction == 2) {
			auto& group = action_st.control_groups.at(owner).at(group_n);
			if (subaction == 0) {
				group.clear();
				for (unit_t* u : selected_units(owner)) {
					if (u->owner != owner) break;
					auto uid = get_unit_id(u);
					if (group.size() == 12) error("attempt to control group more than 12 units");
					group.push_back(uid);
					retval = true;
				}
			} else {
				if (!group.empty()) {
					unit_t* u = get_unit(group[0]);
					if (u && !unit_dead(u) && !unit_can_be_multi_selected(u)) return false;
				}
				for (unit_t* u : selected_units(owner)) {
					if (u->owner != owner) break;
					auto uid = get_unit_id(u);
					if (group.empty() || unit_can_be_multi_selected(u)) {
						auto i = std::find(group.begin(), group.end(), uid);
						if (i == group.end()) {
							if (group.size() == 12) {
								// original buffer overflow bug
								if (group_n != 9) {
									auto& next_group = action_st.control_groups.at(owner).at(group_n + 1);
									if (next_group.empty()) next_group.push_back(uid);
									else next_group[0] = uid;
								}
								break;
							}
							group.push_back(uid);
							retval = true;
							if (group.size() == 12) break;
						}
					}
				}
			}
		} else error("action_control_group: unknown subaction %d", subaction);
		return retval;
	}

	bool action_unload_all(int owner, bool queue) {
		bool retval = false;
		for (unit_t* u : selected_units(owner)) {
			if (!unit_can_receive_order(u, get_order_type(Orders::Unload), owner)) continue;
			if (loaded_units(u).empty()) continue;
			issue_order(u, queue, get_order_type(Orders::Unload), {});
		}
		return retval;
	}

	bool action_unload(int owner, unit_t* target) {
		if (!target) return false;
		if (target->owner != owner) return false;
		if (!target->connected_unit || !u_loaded(target)) return false;
		return unit_unload(target);
	}

	bool action_liftoff(int owner, xy pos) {
		if (!is_in_map_bounds(pos)) return false;
		unit_t* u = get_single_selected_unit(owner);
		if (!u) return false;
		if (unit_is_constructing(u)) return false;
		if (unit_is_researching(u) || unit_is_upgrading(u)) return false;
		if (!unit_can_receive_order(u, get_order_type(Orders::BuildingLiftoff), owner)) return false;
		set_unit_order(u, get_order_type(Orders::BuildingLiftoff), pos);
		set_queued_order(u, false, u->unit_type->return_to_idle, pos - xy(0, 42));
		return true;
	}

	bool action_research(int owner, const tech_type_t* tech) {
		unit_t* u = get_single_selected_unit(owner);
		if (!u) return false;
		if (!unit_can_research(u, tech, owner)) return false;
		if (!has_available_resources_for(u->owner, tech, true)) return false;
		st.current_minerals[u->owner] -= tech->mineral_cost;
		st.current_gas[u->owner] -= tech->gas_cost;
		u->building.researching_type = tech;
		u->building.upgrade_research_time = tech->research_time;
		st.tech_researching[u->owner][tech->id] = true;
		sprite_run_anim(u->sprite, iscript_anims::IsWorking);
		set_unit_order(u, get_order_type(Orders::ResearchTech));
		return true;
	}

	bool action_cancel_research(int owner) {
		unit_t* u = get_single_selected_unit(owner);
		if (!u || u->owner != owner) return false;
		if (!ut_building(u)) return false;
		if (!u_completed(u)) return false;
		if (!unit_is_researching(u)) return false;
		cancel_research(u);
		return true;
	}

	bool action_upgrade(int owner, const upgrade_type_t* upgrade) {
		unit_t* u = get_single_selected_unit(owner);
		if (!u) return false;
		if (!unit_can_upgrade(u, upgrade, owner)) return false;
		if (!has_available_resources_for(u->owner, upgrade, true)) return false;
		st.current_minerals[u->owner] -= upgrade_mineral_cost(owner, upgrade);
		st.current_gas[u->owner] -= upgrade_gas_cost(owner, upgrade);
		u->building.upgrading_type = upgrade;
		u->building.upgrade_research_time = upgrade_time_cost(owner, upgrade);
		u->building.upgrading_level = player_upgrade_level(owner, upgrade->id) + 1;
		st.upgrade_upgrading[u->owner][upgrade->id] = true;
		sprite_run_anim(u->sprite, iscript_anims::IsWorking);
		set_unit_order(u, get_order_type(Orders::Upgrade));
		return true;
	}

	bool action_cancel_upgrade(int owner) {
		unit_t* u = get_single_selected_unit(owner);
		if (!u || u->owner != owner) return false;
		if (!ut_building(u)) return false;
		if (!u_completed(u)) return false;
		if (!unit_is_upgrading(u)) return false;
		cancel_upgrade(u);
		return true;
	}

	bool action_unsiege(int owner, bool queue) {
		bool retval = false;
		for (unit_t* u : selected_units(owner)) {
			if (u->owner != owner) continue;
			if (!unit_is_sieged_tank(u)) continue;
			if (u->order_type->id == Orders::Unsieging) continue;
			if (!unit_can_use_tech(u, get_tech_type(TechTypes::Tank_Siege_Mode))) continue;
			issue_order(u, queue, get_order_type(Orders::Unsieging), {});
			retval = true;
		}
		return retval;
	}

	bool action_siege(int owner, bool queue) {
		bool retval = false;
		for (unit_t* u : selected_units(owner)) {
			if (u->owner != owner) continue;
			if (!unit_is_unsieged_tank(u)) continue;
			if (u->order_type->id == Orders::Sieging) continue;
			if (!unit_can_use_tech(u, get_tech_type(TechTypes::Tank_Siege_Mode))) continue;
			issue_order(u, queue, get_order_type(Orders::Sieging), {});
			retval = true;
		}
		return retval;
	}

	bool action_return_cargo(int owner, bool queue) {
		bool retval = false;
		for (unit_t* u : selected_units(owner)) {
			const order_type_t* order = nullptr;
			if (u->carrying_flags & 2) order = get_order_type(Orders::ReturnMinerals);
			else if (u->carrying_flags & 1) order = get_order_type(Orders::ReturnGas);
			if (!order) continue;
			if (!unit_can_receive_order(u, order, owner)) continue;
			issue_order(u, queue, order, {});
			retval = true;
		}
		return retval;
	}

	bool action_hold_position(int owner, bool queue) {
		bool retval = false;
		for (unit_t* u : selected_units(owner)) {
			const order_type_t* order = get_order_type(Orders::HoldPosition);
			if (unit_is_carrier(u)) order = get_order_type(Orders::CarrierHoldPosition);
			else if (unit_is_reaver(u)) order = get_order_type(Orders::ReaverHoldPosition);
			else if (unit_is_queen(u)) order = get_order_type(Orders::QueenHoldPosition);
			else if (unit_is(u, UnitTypes::Zerg_Scourge) || unit_is(u, UnitTypes::Zerg_Infested_Terran)) order = get_order_type(Orders::SuicideHoldPosition);
			else if (unit_is(u, UnitTypes::Terran_Medic)) order = get_order_type(Orders::MedicHoldPosition);
			if (!unit_can_receive_order(u, order, owner)) continue;
			issue_order(u, queue, order, {});
			retval = true;
		}
		return retval;
	}

	bool action_cloak(int owner) {
		bool retval = false;
		for (unit_t* u : selected_units(owner)) {
			if (u->owner != owner) continue;
			const tech_type_t* tech = nullptr;
			if (unit_is_ghost(u)) tech = get_tech_type(TechTypes::Personnel_Cloaking);
			else if (unit_is_wraith(u)) tech = get_tech_type(TechTypes::Cloaking_Field);
			if (!tech) continue;
			if (!unit_can_use_tech(u, tech)) continue;
			if (u_requires_detector(u)) continue;
			if (u->energy < fp8::integer(tech->energy_cost)) continue;
			u->energy -= fp8::integer(tech->energy_cost);
			set_secondary_order(u, get_order_type(Orders::Cloak));
		}
		return retval;
	}

	bool action_decloak(int owner) {
		bool retval = false;
		for (unit_t* u : selected_units(owner)) {
			if (u->owner != owner) continue;
			const tech_type_t* tech = nullptr;
			if (unit_is_ghost(u)) tech = get_tech_type(TechTypes::Personnel_Cloaking);
			else if (unit_is_wraith(u)) tech = get_tech_type(TechTypes::Cloaking_Field);
			if (!tech) continue;
			if (!unit_can_use_tech(u, tech)) continue;
			set_secondary_order(u, get_order_type(Orders::Decloak));
		}
		return retval;
	}

	bool action_set_alliances(int owner, std::array<int, 12> alliances) {
		st.alliances.at(owner) = alliances;
		for (unit_t* u : ptr(st.player_units[owner])) {
			if (u->order_target.unit && u->order_type->targets_enemies) {
				if (alliances[u->order_target.unit->owner] && !unit_target_is_enemy(u, u->order_target.unit)) {
					u->order_target.unit = nullptr;
				}
			}
		}
		return true;
	}

	bool action_set_shared_vision(int owner, uint32_t flags) {
		flags &= 0xff;
		flags |= st.shared_vision.at(owner) & 0xff00;
		st.shared_vision.at(owner) = flags;
		return true;
	}

	bool action_cancel_addon(int owner) {
		unit_t* u = get_single_selected_unit(owner);
		if (!u || u->owner != owner) return false;
		if (!u_completed(u)) return false;
		if (!u_grounded_building(u)) return false;
		if (u->secondary_order_type->id != Orders::BuildAddon) return false;
		unit_t* addon = u->current_build_unit;
		if (!addon) return false;
		if (u_completed(addon)) return false;
		cancel_building_unit(addon);
		return true;
	}

	bool action_stim_pack(int owner) {
		bool retval = false;
		for (unit_t* u : selected_units(owner)) {
			if (u->owner != owner) continue;
			if (!unit_can_use_tech(u, get_tech_type(TechTypes::Stim_Packs))) continue;
			if (u->hp <= fp8::integer(10)) continue;
			play_sound(lcg_rand(31, 278, 279), u);
			unit_deal_damage(u, fp8::integer(10), nullptr, ~0);
			if (u->stim_timer < 37) {
				u->stim_timer = 37;
				update_unit_speed(u);
			}
			retval = true;
		}
		return retval;
	}

	bool action_cancel_nuke(int owner) {
		bool retval = false;
		for (unit_t* u : selected_units(owner)) {
			if (!unit_is_ghost(u)) continue;
			if (!u->connected_unit || !unit_is(u->connected_unit, UnitTypes::Terran_Nuclear_Missile)) continue;
			u->connected_unit->connected_unit = nullptr;
			u->connected_unit = nullptr;
			retval = true;
		}
		return retval;
	}

	bool action_morph(int owner, const unit_type_t* unit_type) {
		bool retval = false;
		for (unit_t* u : selected_units(owner)) {
			if (u->owner != owner) continue;
			if (unit_is(u, UnitTypes::Zerg_Hydralisk) && unit_is(unit_type, UnitTypes::Zerg_Lurker)) {
				if (!unit_can_use_tech(u, get_tech_type(TechTypes::Lurker_Aspect))) continue;
			} else if (unit_is(u, UnitTypes::Zerg_Larva) || unit_is(u, UnitTypes::Zerg_Mutalisk)) {
				if (!unit_can_build(u, unit_type)) continue;
			} else continue;
			if (u->order_type->id == Orders::ZergUnitMorph) continue;
			if (!build_queue_push(u, unit_type)) continue;
			set_unit_order(u, get_order_type(Orders::ZergUnitMorph));
			retval = true;
		}
		return retval;
	}

	bool action_morph_building(int owner, const unit_type_t* unit_type) {
		if (!unit_is_zerg_building(unit_type)) return false;
		bool retval = false;
		for (unit_t* u : selected_units(owner)) {
			if (u->owner != owner) continue;
			if (!unit_is_zerg_building(u)) continue;
			if (!unit_can_build(u, unit_type)) continue;
			if (!build_queue_push(u, unit_type)) continue;
			if (u->order_type->id != Orders::ZergBuildingMorph) set_unit_order(u, get_order_type(Orders::ZergBuildingMorph));
			retval = true;
		}
		return retval;
	}
	
	bool action_burrow(int owner, bool queue) {
		bool retval = false;
		for (unit_t* u : selected_units(owner)) {
			if (!unit_can_use_tech(u, get_tech_type(TechTypes::Burrowing), owner)) continue;
			if (u_burrowed(u)) continue;
			if (u->order_type->id == Orders::Burrowing) continue;
			issue_order(u, queue, get_order_type(Orders::Burrowing), {});
			retval = true;
		}
		return retval;
	}
	
	bool action_unburrow(int owner) {
		bool retval = false;
		for (unit_t* u : selected_units(owner)) {
			if (!unit_can_use_tech(u, get_tech_type(TechTypes::Burrowing), owner)) continue;
			if (!ut_can_burrow(u)) continue;
			unburrow_unit(u);
			retval = true;
		}
		return retval;
	}
	
	bool action_cancel_morph(int owner) {
		bool retval = false;
		for (unit_t* u : selected_units(owner)) {
			if (!u || u->owner != owner) return false;
			if (cancel_building_unit(u)) retval = true;
		}
		return retval;
	}
	
	bool action_morph_archon(int owner) {
		return morph_archon_impl(owner, false);
	}
	
	bool action_carrier_stop(int owner) {
		bool retval = false;
		for (unit_t* u : selected_units(owner)) {
			if (!unit_can_receive_order(u, get_order_type(Orders::CarrierStop), owner)) continue;
			set_unit_order(u, get_order_type(Orders::CarrierStop));
			retval = true;
		}
		return retval;
	}
	
	bool action_train_fighter(int owner) {
		bool retval = false;
		for (unit_t* u : selected_units(owner)) {
			if (u->owner != owner) continue;
			const unit_type_t* build_type = nullptr;
			if (unit_is_carrier(u)) build_type = get_unit_type(UnitTypes::Protoss_Interceptor);
			else if (unit_is_reaver(u)) build_type = get_unit_type(UnitTypes::Protoss_Scarab);
			if (!build_type) continue;
			if (!unit_can_build(u, build_type)) continue;
			if (!build_queue_push(u, build_type)) continue;
			if (u->secondary_order_state != 2) {
				u->secondary_order_type = nullptr;
				set_secondary_order(u, get_order_type(Orders::TrainFighter));
			}
			retval = true;
		}
		return retval;
	}
	
	bool action_morph_dark_archon(int owner) {
		return morph_archon_impl(owner, true);
	}
	
	bool action_reaver_stop(int owner) {
		bool retval = false;
		for (unit_t* u : selected_units(owner)) {
			if (!unit_can_receive_order(u, get_order_type(Orders::ReaverStop), owner)) continue;
			set_unit_order(u, get_order_type(Orders::ReaverStop));
			retval = true;
		}
		return retval;
	}
	
	bool action_player_leave(int owner, int reason) {
		if (reason == 6) player_dropped(owner);
		else player_left(owner);
		return true;
	}
	
	bool action_cheat(int owner, int flags) {
		if (!st.cheats_enabled) return false;
		st.cheat_operation_cwal = (flags & 2) != 0;
		if (flags & 2) flags &= ~2;
		if (flags & 0x10) {
			flags &=  ~0x10;
			for (size_t i = 0; i != 12; ++i) {
				if (st.players[i].controller == player_t::controller_occupied) {
					st.current_minerals[i] += 10000;
					st.current_gas[i] += 10000;
				}
			}
		}
		if (flags) error("unknown cheat flag(s) %#x", flags);
		return true;
	}

	template<typename reader_T>
	bool read_action_select(int owner, reader_T&& r) {
		size_t n = r.template get<uint8_t>();
		if (n > 12) error("invalid selection of %d units", n);
		static_vector<unit_t*, 12> units;
		for (size_t i = 0; i != n; ++i) {
			auto uid = unit_id(r.template get<uint16_t>());
			units.push_back(get_unit(uid));
		}
		return action_select(owner, units);
	}

	template<typename reader_T>
	bool read_action_shift_select(int owner, reader_T&& r) {
		size_t n = r.template get<uint8_t>();
		if (n > 12) error("invalid selection of %d units", n);
		static_vector<unit_t*, 12> units;
		for (size_t i = 0; i != n; ++i) {
			auto uid = unit_id(r.template get<uint16_t>());
			units.push_back(get_unit(uid));
		}
		return action_shift_select(owner, units);
	}

	template<typename reader_T>
	bool read_action_deselect(int owner, reader_T&& r) {
		size_t n = r.template get<uint8_t>();
		if (n > 12) error("invalid deselection of %d units", n);
		static_vector<unit_t*, 12> units;
		for (size_t i = 0; i != n; ++i) {
			auto uid = unit_id(r.template get<uint16_t>());
			units.push_back(get_unit(uid));
		}
		return action_deselect(owner, units);
	}

	// StarCraft: Remastered added "extended" variants of several unit-targeting
	// commands (right-click, targeted order, unload, select/shift-select/deselect -
	// action ids 0x60-0x65) that Remastered's client unconditionally emits instead
	// of the classic versions, so replaying any modern replay requires handling them.
	//
	// The wire format for each unit reference is wider (4 bytes instead of 2), which
	// looks like a widened unit id at first glance - and matches the byte layout
	// icza/screp (https://github.com/icza/screp, MIT) independently documents,
	// decoding it as `UnitTag = getUint16(); getUint16() // Unknown, always 0`.
	// But screp is a passive parser: it never needs to resolve a UnitTag back to a
	// live unit, so that byte layout alone doesn't tell you how to do so, and it is
	// NOT simply OpenBW's classic packed (11-bit index, 5-bit generation) unit_id
	// widened to 32 bits - two earlier attempts at that (both a genuine 32-bit
	// unit_id_32 packed id, and reading a 16-bit packed id from the low half only)
	// silently "succeeded" (no error) while resolving to nothing, since the
	// resulting index just doesn't line up with anything in OpenBW's unit table.
	//
	// The real relationship, confirmed empirically against a live replay by
	// recording every SELECT_EXT unit tag alongside a full dump of OpenBW's live
	// unit table at the same frame (both players, 14 units total, exact match on
	// every one): UnitTag = raw 0-based index into OpenBW's unit table, plus a
	// constant offset - i.e. a flat index, with NO generation component at all.
	// The offset (see kExtUnitTagOffset below) was empirically derived from one
	// replay; it should be re-validated against replays from other game
	// versions/limit configurations before being fully trusted.
	// UPDATE: the "flat index plus a constant 9893" reading above is wrong, and
	// the reason it looked right is that 9893 = (1 << 13) | 1701. The tag is
	// actually a packed value - a 13-bit slot number with a generation counter
	// above it - and every unit in the original 14-sample derivation happened to
	// be generation 1, which made "subtract 8192 + 1701" and "strip the
	// generation, then subtract 1701" indistinguishable. They stop agreeing the
	// moment any slot is recycled.
	//
	// Established empirically (native/analyzeTags.mjs, and the candidate probe in
	// probe_ext_tag below, scored against the live unit table across real
	// tournament replays):
	//   - slot numbers occupy a 1700-wide window starting at 1701, matching the
	//     size of BW's unit table, so the mapping to OpenBW is slot - 1701;
	//   - the offset is exactly 1701: scoring 1700 and 1702 as well gives a sharp
	//     peak at 1701 (1570 correctly-owned resolutions vs 1026 and 1012), so it
	//     is not curve-fitting noise;
	//   - stripping the generation beats the old constant in every two-minute
	//     bucket of every replay tested.
	//
	// This is a real improvement but NOT a complete fix, and the remaining gap is
	// not in this function. Even with the correct decode, resolution starts around
	// 66-89% early in a game and decays to single digits by the end, because
	// OpenBW's unit-slot allocation order drifts out of step with the real
	// client's. That is self-reinforcing: a tag that fails to resolve drops a
	// command, dropping a command changes which units get created, and that pushes
	// the slot numbering further out of step. Closing it means matching the
	// client's allocation and recycling order exactly, which is engine work, not
	// arithmetic. Until then, treat mid-game state from this simulation as
	// approximate and watch action_state::ext_tag_failures.
	static constexpr size_t kExtUnitTagOffset = 9893; // kept for reference; see probe candidate 0
	static constexpr uint16_t kExtUnitTagSlotMask = 0x1fff;
	static constexpr size_t kExtUnitTagSlotBase = 1701;

	unit_t* get_unit_by_ext_tag(uint16_t tag) {
		++action_st.ext_tag_lookups;
		size_t slot = tag & kExtUnitTagSlotMask;
		if (slot < kExtUnitTagSlotBase) {
			++action_st.ext_tag_failures;
			return nullptr;
		}
		unit_t* u = get_unit(slot - kExtUnitTagSlotBase);
		if (!u) ++action_st.ext_tag_failures;
		return u;
	}

	// See action_state::tag_probe. Candidate order must stay in sync with the
	// label table in bwlive.cpp.
	void probe_ext_tag(int owner, uint16_t tag) {
		if (!action_st.tag_probe_enabled) return;
		++action_st.tag_probe_total;
		size_t bucket = (size_t)(st.current_frame / action_state::tag_probe_bucket_frames);
		if (bucket >= action_state::tag_probe_buckets) bucket = action_state::tag_probe_buckets - 1;
		++action_st.tag_probe_by_time_total[bucket];
		auto score = [&](size_t candidate, unit_t* u) {
			if (!u) return;
			++action_st.tag_probe[candidate].live;
			++action_st.tag_probe_by_time[bucket][candidate].live;
			if (u->owner == owner) {
				++action_st.tag_probe[candidate].owned;
				++action_st.tag_probe_by_time[bucket][candidate].owned;
			}
		};
		auto by_index = [&](size_t candidate, long long index) {
			if (index < 0) return;
			score(candidate, get_unit((size_t)index));
		};
		// object_container maps an external index k to internal slot max_size - k,
		// so any candidate producing a value above 1700 can never resolve. That
		// rules out the raw masked indices (which run up to ~3400) and points at
		// SC:R's slot numbers living in [1701, 3400] - a 1700-wide window, i.e.
		// the same table, offset. Note 9893 = 8192 + 1701: the current constant is
		// exactly "strip a generation of 1, then subtract 1701", which is why it
		// held for the original 14 early-game samples and nowhere else.
		by_index(0, (long long)tag - (long long)kExtUnitTagOffset); // current behaviour
		by_index(1, (long long)(tag & 0x1fff) - 1701);              // strip generation, then offset
		by_index(2, (long long)(tag & 0x1fff) - 1700);
		by_index(3, (long long)(tag & 0x1fff) - 1702);
		by_index(4, (long long)(tag & 0x0fff) - 1701);              // same, if the split is 12-bit
		by_index(5, tag % 1700);                                    // non-power-of-2 id scheme
		by_index(6, tag % 1701);
		by_index(7, (long long)(tag & 0x1fff) % 1700);
		by_index(8, 3400 - (long long)(tag & 0x1fff));              // window counted downwards
		score(9, get_unit(unit_id(tag)));   // classic packed id, generation checked
	}

	template<typename reader_T>
	bool read_action_select_ext(int owner, reader_T&& r) {
		size_t n = r.template get<uint8_t>();
		if (n > 12) error("invalid selection of %d units", n);
		static_vector<unit_t*, 12> units;
		for (size_t i = 0; i != n; ++i) {
			uint16_t tag = r.template get<uint16_t>();
			r.template get<uint16_t>(); // padding, always 0
			probe_ext_tag(owner, tag);
			units.push_back(get_unit_by_ext_tag(tag));
		}
		return action_select(owner, units);
	}

	template<typename reader_T>
	bool read_action_shift_select_ext(int owner, reader_T&& r) {
		size_t n = r.template get<uint8_t>();
		if (n > 12) error("invalid selection of %d units", n);
		static_vector<unit_t*, 12> units;
		for (size_t i = 0; i != n; ++i) {
			uint16_t tag = r.template get<uint16_t>();
			r.template get<uint16_t>(); // padding, always 0
			probe_ext_tag(owner, tag);
			units.push_back(get_unit_by_ext_tag(tag));
		}
		return action_shift_select(owner, units);
	}

	template<typename reader_T>
	bool read_action_deselect_ext(int owner, reader_T&& r) {
		size_t n = r.template get<uint8_t>();
		if (n > 12) error("invalid deselection of %d units", n);
		static_vector<unit_t*, 12> units;
		for (size_t i = 0; i != n; ++i) {
			uint16_t tag = r.template get<uint16_t>();
			r.template get<uint16_t>(); // padding, always 0
			probe_ext_tag(owner, tag);
			units.push_back(get_unit_by_ext_tag(tag));
		}
		return action_deselect(owner, units);
	}

	template<typename reader_T>
	bool read_action_train(int owner, reader_T&& r) {
		auto* unit_type = get_unit_type((UnitTypes)r.template get<uint16_t>());
		return action_train(owner, unit_type);
	}

	template<typename reader_T>
	bool read_action_default_order(int owner, reader_T&& r) {
		int x = r.template get<int16_t>();
		int y = r.template get<int16_t>();
		unit_t* target = get_unit(unit_id(r.template get<uint16_t>()));
		UnitTypes target_unit_type_id = (UnitTypes)r.template get<uint16_t>();
		const unit_type_t* target_unit_type = target_unit_type_id == UnitTypes::None ? nullptr : get_unit_type(target_unit_type_id);
		bool queue = r.template get<uint8_t>() != 0;
		return action_default_order(owner, {x, y}, target, target_unit_type, queue);
	}

	// RIGHT_CLICK_EXT (0x60): same as read_action_default_order above, target
	// resolved via the extended-tag scheme - see the SELECT_EXT comment.
	template<typename reader_T>
	bool read_action_default_order_ext(int owner, reader_T&& r) {
		int x = r.template get<int16_t>();
		int y = r.template get<int16_t>();
		uint16_t target_tag = r.template get<uint16_t>();
		r.template get<uint16_t>(); // padding, always 0
		unit_t* target = get_unit_by_ext_tag(target_tag);
		UnitTypes target_unit_type_id = (UnitTypes)r.template get<uint16_t>();
		const unit_type_t* target_unit_type = target_unit_type_id == UnitTypes::None ? nullptr : get_unit_type(target_unit_type_id);
		bool queue = r.template get<uint8_t>() != 0;
		return action_default_order(owner, {x, y}, target, target_unit_type, queue);
	}

	template<typename reader_T>
	bool read_action_player_leave(int owner, reader_T&& r) {
		int reason = r.template get<int8_t>();
		return action_player_leave(owner, reason);
	}

	template<typename reader_T>
	bool read_action_build(int owner, reader_T&& r) {
		auto* order_type = get_order_type((Orders)r.template get<uint8_t>());
		size_t tile_x = r.template get<uint16_t>();
		size_t tile_y = r.template get<uint16_t>();
		auto* unit_type = get_unit_type((UnitTypes)r.template get<uint16_t>());
		return action_build(owner, order_type, unit_type, {tile_x, tile_y});
	}

	template<typename reader_T>
	bool read_action_stop(int owner, reader_T&& r) {
		bool queue = r.template get<uint8_t>() != 0;
		return action_stop(owner, queue);
	}

	template<typename reader_T>
	bool read_action_order(int owner, reader_T&& r) {
		int x = r.template get<int16_t>();
		int y = r.template get<int16_t>();
		unit_t* target = get_unit(unit_id(r.template get<uint16_t>()));
		UnitTypes target_unit_type_id = (UnitTypes)r.template get<uint16_t>();
		const unit_type_t* target_unit_type = target_unit_type_id == UnitTypes::None ? nullptr : get_unit_type(target_unit_type_id);
		Orders order_id = (Orders)r.template get<uint8_t>();
		const order_type_t* order_type = get_order_type(order_id);
		bool queue = r.template get<uint8_t>() != 0;
		return action_order(owner, order_type, {x, y}, target, target_unit_type, queue);
	}

	// TARGETED_ORDER_EXT (0x61): same as read_action_order above, with a 16-bit
	// padding field after the (still 16-bit) target id - see the SELECT_EXT comment.
	template<typename reader_T>
	bool read_action_order_ext(int owner, reader_T&& r) {
		int x = r.template get<int16_t>();
		int y = r.template get<int16_t>();
		uint16_t target_tag = r.template get<uint16_t>();
		r.template get<uint16_t>(); // padding, always 0
		unit_t* target = get_unit_by_ext_tag(target_tag);
		UnitTypes target_unit_type_id = (UnitTypes)r.template get<uint16_t>();
		const unit_type_t* target_unit_type = target_unit_type_id == UnitTypes::None ? nullptr : get_unit_type(target_unit_type_id);
		Orders order_id = (Orders)r.template get<uint8_t>();
		const order_type_t* order_type = get_order_type(order_id);
		bool queue = r.template get<uint8_t>() != 0;
		return action_order(owner, order_type, {x, y}, target, target_unit_type, queue);
	}

	template<typename reader_T>
	bool read_action_cancel_building_unit(int owner, reader_T&& r) {
		return action_cancel_building_unit(owner);
	}

	template<typename reader_T>
	bool read_action_cancel_build_queue(int owner, reader_T&& r) {
		size_t slot = r.template get<uint16_t>();
		return action_cancel_build_queue(owner, slot);
	}

	template<typename reader_T>
	bool read_action_control_group(int owner, reader_T&& r) {
		int subaction = r.template get<uint8_t>();
		size_t group_n = r.template get<uint8_t>();
		if (group_n > 10) return false;
		return action_control_group(owner, group_n, subaction);
	}

	template<typename reader_T>
	bool read_action_unload_all(int owner, reader_T&& r) {
		bool queue = r.template get<uint8_t>() != 0;
		return action_unload_all(owner, queue);
	}

	template<typename reader_T>
	bool read_action_unload(int owner, reader_T&& r) {
		unit_t* target = get_unit(unit_id(r.template get<uint16_t>()));
		return action_unload(owner, target);
	}

	// UNLOAD_EXT (0x62): same as read_action_unload above, with a 16-bit padding
	// field after the (still 16-bit) target id - see the SELECT_EXT comment.
	template<typename reader_T>
	bool read_action_unload_ext(int owner, reader_T&& r) {
		uint16_t target_tag = r.template get<uint16_t>();
		r.template get<uint16_t>(); // padding, always 0
		unit_t* target = get_unit_by_ext_tag(target_tag);
		return action_unload(owner, target);
	}

	template<typename reader_T>
	bool read_action_liftoff(int owner, reader_T&& r) {
		int x = r.template get<int16_t>();
		int y = r.template get<int16_t>();
		return action_liftoff(owner, xy(x, y));
	}

	template<typename reader_T>
	bool read_action_research(int owner, reader_T&& r) {
		const tech_type_t* tech = get_tech_type((TechTypes)r.template get<uint8_t>());
		return action_research(owner, tech);
	}

	template<typename reader_T>
	bool read_action_cancel_research(int owner, reader_T&& r) {
		return action_cancel_research(owner);
	}

	template<typename reader_T>
	bool read_action_upgrade(int owner, reader_T&& r) {
		const upgrade_type_t* upgrade = get_upgrade_type((UpgradeTypes)r.template get<uint8_t>());
		return action_upgrade(owner, upgrade);
	}

	template<typename reader_T>
	bool read_action_cancel_upgrade(int owner, reader_T&& r) {
		return action_cancel_upgrade(owner);
	}

	template<typename reader_T>
	bool read_action_unsiege(int owner, reader_T&& r) {
		bool queue = r.template get<uint8_t>() != 0;
		return action_unsiege(owner, queue);
	}

	template<typename reader_T>
	bool read_action_siege(int owner, reader_T&& r) {
		bool queue = r.template get<uint8_t>() != 0;
		return action_siege(owner, queue);
	}

	template<typename reader_T>
	bool read_action_chat(int owner, reader_T&& r) {
		auto buf = r.template get<std::array<uint8_t, 81>>();
		a_string str;
		for (auto& v : buf) {
			if (v == 0) break;
			if (v >= 32) str += (char)v;
		}
		return true;
	}

	template<typename reader_T>
	bool read_action_return_cargo(int owner, reader_T&& r) {
		bool queue = r.template get<uint8_t>() != 0;
		return action_return_cargo(owner, queue);
	}

	template<typename reader_T>
	bool read_action_hold_position(int owner, reader_T&& r) {
		bool queue = r.template get<uint8_t>() != 0;
		return action_hold_position(owner, queue);
	}

	template<typename reader_T>
	bool read_action_cloak(int owner, reader_T&& r) {
		r.template get<uint8_t>();
		return action_cloak(owner);
	}

	template<typename reader_T>
	bool read_action_decloak(int owner, reader_T&& r) {
		r.template get<uint8_t>();
		return action_decloak(owner);
	}

	template<typename reader_T>
	bool read_action_set_alliances(int owner, reader_T&& r) {
		std::array<int, 12> arr;
		uint32_t vals = r.template get<uint32_t>();
		for (size_t i = 0; i != 12; ++i) {
			arr[i] = vals & 3;
			vals >>= 2;
		}
		return action_set_alliances(owner, arr);
	}

	template<typename reader_T>
	bool read_action_set_shared_vision(int owner, reader_T&& r) {
		uint32_t flags = r.template get<uint16_t>();
		return action_set_shared_vision(owner, flags);
	}

	template<typename reader_T>
	bool read_action_cancel_addon(int owner, reader_T&& r) {
		return action_cancel_addon(owner);
	}

	template<typename reader_T>
	bool read_action_stim_pack(int owner, reader_T&& r) {
		return action_stim_pack(owner);
	}

	template<typename reader_T>
	bool read_action_cancel_nuke(int owner, reader_T&& r) {
		return action_cancel_nuke(owner);
	}

	template<typename reader_T>
	bool read_action_ping_minimap(int owner, reader_T&& r) {
		r.template get<uint16_t>();
		r.template get<uint16_t>();
		return true;
	}

	template<typename reader_T>
	bool read_action_morph(int owner, reader_T&& r) {
		auto* unit_type = get_unit_type((UnitTypes)r.template get<uint16_t>());
		return action_morph(owner, unit_type);
	}

	template<typename reader_T>
	bool read_action_morph_building(int owner, reader_T&& r)  {
		auto* unit_type = get_unit_type((UnitTypes)r.template get<uint16_t>());
		return action_morph_building(owner, unit_type);
	}
	
	template<typename reader_T>
	bool read_action_burrow(int owner, reader_T&& r) {
		bool queue = r.template get<uint8_t>() != 0;
		return action_burrow(owner, queue);
	}
	
	template<typename reader_T>
	bool read_action_unburrow(int owner, reader_T&& r) {
		r.template get<uint8_t>();
		return action_unburrow(owner);
	}
	
	template<typename reader_T>
	bool read_action_cancel_morph(int owner, reader_T&& r) {
		return action_cancel_morph(owner);
	}
	
	template<typename reader_T>
	bool read_action_morph_archon(int owner, reader_T&& r) {
		return action_morph_archon(owner);
	}
	
	template<typename reader_T>
	bool read_action_carrier_stop(int owner, reader_T&& r) {
		return action_carrier_stop(owner);
	}
	
	template<typename reader_T>
	bool read_action_train_fighter(int owner, reader_T&& r) {
		return action_train_fighter(owner);
	}
	
	template<typename reader_T>
	bool read_action_morph_dark_archon(int owner, reader_T&& r) {
		return action_morph_dark_archon(owner);
	}
	
	template<typename reader_T>
	bool read_action_reaver_stop(int owner, reader_T&& r) {
		return action_reaver_stop(owner);
	}
	
	template<typename reader_T>
	bool read_action_cheat(int owner, reader_T&& r) {
		int flags = r.template get<uint32_t>();
		return action_cheat(owner, flags);
	}

	template<typename reader_T>
	bool read_action_ext_cheat(int owner, reader_T&& r) {
		int type = r.template get<uint8_t>();
		if (type == 0) {
			int subtype = r.template get<uint8_t>();
			unit_t* target = get_unit(unit_id(r.template get<uint16_t>()));
			if (subtype == 0) {
				int value = r.template get<int32_t>();
				set_unit_hp(target, fp8::integer(value));
			} else if (subtype == 1) {
				int value = r.template get<int32_t>();
				set_unit_shield_points(target, fp8::integer(value));
			} else if (subtype == 2) {
				int value = r.template get<int32_t>();
				set_unit_energy(target, fp8::integer(value));
			} else error("unknown ext cheat unit subtype %d", subtype);
		} else if (type == 1) {
			int subtype = r.template get<uint8_t>();
			int player = r.template get<uint8_t>();
			if (subtype == 0) {
				const upgrade_type_t* upgrade = get_upgrade_type((UpgradeTypes)r.template get<uint8_t>());
				int level = r.template get<int8_t>();
				st.upgrade_levels.at(player)[upgrade->id] = level;
				apply_upgrades_to_player_units(player);
			} else if (subtype == 1) {
				const tech_type_t* tech = get_tech_type((TechTypes)r.template get<uint8_t>());
				int researched = r.template get<int8_t>();
				st.tech_researched.at(player)[tech->id] = researched;
			} else if (subtype == 2) {
				int value = r.template get<int32_t>();
				st.current_minerals.at(player) = value;
			} else if (subtype == 3) {
				int value = r.template get<int32_t>();
				st.current_gas.at(player) = value;
			} else error("unknown ext cheat player subtype %d", subtype);
		} else error("unknown ext cheat type %d", type);
		return true;
	}

	virtual void on_action(int owner, int action) {
	}

	template<typename reader_T>
	bool read_action(reader_T&& r) {
		int player_id = r.template get<uint8_t>();
		auto i = std::find(action_st.player_id.begin(), action_st.player_id.end(), player_id);
		if (i == action_st.player_id.end()) {
			// Not a registered player slot. Confirmed empirically (byte-for-byte cross
			// checked against an independent parser) that this is a real, correctly
			// aligned value, not a stream desync: observers/casters can send chat
			// messages tagged with an out-of-band player_id (128 seen on a real
			// tournament Finals replay - pool-stage 1v1s with no observers never hit
			// this) that doesn't appear in the header's occupied-slot list. Chat has no
			// effect on game state, so skip it (still consuming exactly its bytes to
			// stay aligned) rather than aborting the whole simulation. Anything other
			// than chat from an unrecognized sender is still a hard error, since there's
			// no generic way to know how many bytes to skip for an arbitrary action type
			// from a sender we don't have a slot for.
			int action_id = r.template get<uint8_t>();
			if (action_id == 92) {
				r.template get<std::array<uint8_t, 81>>();
				return true;
			}
			error("execute_action: player id %d not found (action %d)", player_id, action_id);
		}
		int owner = (int)(i - action_st.player_id.begin());
		return read_action(owner, r);
	}
	template<typename reader_T>
	bool read_action(int owner, reader_T&& r) {
		int action_id = r.template get<uint8_t>();
		on_action(owner, action_id);
		switch (action_id) {
		case 9:
			return read_action_select(owner, r);
		case 10:
			return read_action_shift_select(owner, r);
		case 11:
			return read_action_deselect(owner, r);
		case 12:
			return read_action_build(owner, r);
		case 13:
			return read_action_set_shared_vision(owner, r);
		case 14:
			return read_action_set_alliances(owner, r);
		case 18:
			return read_action_cheat(owner, r);
		case 19:
			return read_action_control_group(owner, r);
		case 20:
			return read_action_default_order(owner, r);
		case 21:
			return read_action_order(owner, r);
		case 24:
			return read_action_cancel_building_unit(owner, r);
		case 25:
			return read_action_cancel_morph(owner, r);
		case 26:
			return read_action_stop(owner, r);
		case 27:
			return read_action_carrier_stop(owner, r);
		case 28:
			return read_action_reaver_stop(owner, r);
		case 30:
			return read_action_return_cargo(owner, r);
		case 31:
			return read_action_train(owner, r);
		case 32:
			return read_action_cancel_build_queue(owner, r);
		case 33:
			return read_action_cloak(owner, r);
		case 34:
			return read_action_decloak(owner, r);
		case 35:
			return read_action_morph(owner, r);
		case 37:
			return read_action_unsiege(owner, r);
		case 38:
			return read_action_siege(owner, r);
		case 39:
			return read_action_train_fighter(owner, r);
		case 40:
			return read_action_unload_all(owner, r);
		case 41:
			return read_action_unload(owner, r);
		case 42:
			return read_action_morph_archon(owner, r);
		case 43:
			return read_action_hold_position(owner, r);
		case 44:
			return read_action_burrow(owner, r);
		case 45:
			return read_action_unburrow(owner, r);
		case 46:
			return read_action_cancel_nuke(owner, r);
		case 47:
			return read_action_liftoff(owner, r);
		case 48:
			return read_action_research(owner, r);
		case 49:
			return read_action_cancel_research(owner, r);
		case 50:
			return read_action_upgrade(owner, r);
		case 51:
			return read_action_cancel_upgrade(owner, r);
		case 52:
			return read_action_cancel_addon(owner, r);
		case 53:
			return read_action_morph_building(owner, r);
		case 54:
			return read_action_stim_pack(owner, r);
		case 87:
			return read_action_player_leave(owner, r);
		case 88:
			return read_action_ping_minimap(owner, r);
		case 90:
			return read_action_morph_dark_archon(owner, r);
		case 92:
			return read_action_chat(owner, r);
		case 210:
			return read_action_ext_cheat(owner, r);
		case 0x60:
			return read_action_default_order_ext(owner, r);
		case 0x61:
			return read_action_order_ext(owner, r);
		case 0x62:
			return read_action_unload_ext(owner, r);
		case 0x63:
			return read_action_select_ext(owner, r);
		case 0x64:
			return read_action_shift_select_ext(owner, r);
		case 0x65:
			return read_action_deselect_ext(owner, r);
		default:
			error("execute_action: unknown action %d", action_id);
		}
		return false;
	}

	bool read_action(const uint8_t* data, size_t data_size) {
		data_loading::data_reader_le r(data, data + data_size);
		return read_action(r);
	}
	
	bool read_action(int owner, const uint8_t* data, size_t data_size) {
		data_loading::data_reader_le r(data, data + data_size);
		return read_action(owner, r);
	}

	void execute_actions(uint8_t* actions_data_begin, uint8_t* actions_data_end) {
		if (st.current_frame != action_st.next_action_frame) return;
		while (action_st.actions_data_position != size_t(actions_data_end - actions_data_begin)) {
			data_loading::data_reader_le r(actions_data_begin + action_st.actions_data_position, actions_data_end);
			int frame = r.get<int32_t>();
			if (frame != st.current_frame) {
				action_st.next_action_frame = frame;
				return;
			}
			size_t actions_size = r.get<uint8_t>();
			const uint8_t* ptr = r.get_n(actions_size);
			const uint8_t* end = ptr + actions_size;
			data_loading::data_reader_le r2(ptr, end);
			while (r2.ptr != end) {
				read_action(r2);
			}
			action_st.actions_data_position = end - actions_data_begin;
		}
	}

};

}

#endif
