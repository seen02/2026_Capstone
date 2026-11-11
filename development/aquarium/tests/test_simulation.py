import copy
import json
import unittest
from collections import Counter
from pathlib import Path
from aquarium_sim.engine import Simulation, arrival_schedule, arrival_weights, clock_seconds, MapGraph
from scripts.import_arrivals import import_counts

ROOT=Path(__file__).resolve().parents[1]
CONFIG=json.loads((ROOT/"configs/day.json").read_text(encoding="utf-8"))
MAP=json.loads((ROOT/"configs/aquarium_map.json").read_text(encoding="utf-8"))

class ArrivalTests(unittest.TestCase):
    def test_synthetic_profile_has_smooth_morning_and_afternoon_peaks(self):
        rates=arrival_weights(CONFIG)
        self.assertEqual(len(rates),480)
        self.assertGreater(rates[60],rates[150])
        self.assertGreater(rates[270],rates[150])
        self.assertGreater(rates[270],rates[450])
        self.assertTrue(all(abs(a-b)<.03 for a,b in zip(rates,rates[1:])))
        for invalid in [0,-1,float("nan")]:
            c=copy.deepcopy(CONFIG);c["arrivals"]["peaks"][0]["sigma_hours"]=invalid
            with self.assertRaises(ValueError):arrival_schedule(c)

    def test_random_minutes_and_reproducibility(self):
        times=arrival_schedule(CONFIG)
        self.assertEqual(len(times),CONFIG["daily_visitors"])
        self.assertEqual(times,arrival_schedule(CONFIG))
        changed=copy.deepcopy(CONFIG);changed["seed"]+=1
        self.assertNotEqual(times,arrival_schedule(changed))
        opening=clock_seconds(CONFIG["opening"])
        last=clock_seconds(CONFIG["last_entry"])
        self.assertTrue(all(opening<t<last and t%60!=0 for t in times))
        counts=Counter(int((t-opening)//60) for t in times)
        values=[counts[i] for i in range(480)]
        self.assertGreater(len(set(values)),5)
        self.assertLess(max(values),30)

    def test_empirical_profile_and_missing_data(self):
        rows=[dict(time=f"{t//60:02}:{t%60:02}",count=1 if t==600 else 0) for t in range(570,1050)]
        c=import_counts(CONFIG,rows,"테스트용 합성 집계")
        self.assertTrue(all(36000<=t<36060 for t in arrival_schedule(c)))
        with self.assertRaises(ValueError):import_counts(CONFIG,rows[:-1],"합성")
        c["arrivals"]["minute_weights"][0]=float("nan")
        with self.assertRaises(ValueError):arrival_schedule(c)

class FlowTests(unittest.TestCase):
    def test_single_floor_room_access(self):
        graph=MapGraph(MAP)
        self.assertEqual({n["floor"] for n in MAP["nodes"]},{"1F"})
        self.assertEqual({n["id"] for n in MAP["nodes"] if n["kind"]=="exhibit"},set("ABCDEF"))
        self.assertEqual(len(MAP["signs"]),3)
        for room in MAP["geometry"]["rooms"]:
            zone=room["id"]
            self.assertIn(room["queue_node"],graph.routes("entry")[0])
            _,prev=graph.routes(zone)
            outward=[n for n,_ in graph.path(prev,zone,"exit")]
            if room["access_mode"]=="controlled_show":
                self.assertIn(room["exit_door"],outward)
                self.assertNotIn(room["entry_door"],outward)
            else:
                self.assertIsNone(room["entry_door"])
                self.assertIsNone(room["exit_door"])
                self.assertTrue(all(not e.get("directed",False) for e in MAP["edges"] if zone in (e["a"],e["b"])))
        self.assertEqual({d["room"] for d in MAP["geometry"]["doors"]},{"F"})
        self.assertEqual(MAP["geometry"]["service_areas"],[])
        sim=Simulation(MAP,CONFIG);sim.advance_to(clock_seconds("11:00"))
        self.assertGreater(sim.snapshot()["metrics"]["inside"],0)
        self.assertTrue(all(v["node"] in graph.nodes for v in sim.snapshot()["visitors"]))

    def test_shortcuts_and_exhibit_transit(self):
        graph=MapGraph(MAP)
        west,east=MAP["signs"][0]["node"],MAP["signs"][2]["node"]
        short,prev=graph.routes(west)
        self.assertTrue(any(graph.edges[e]["kind"]=="shortcut" for _,e in graph.path(prev,west,east)))
        for source in ["entry"]+list("ABCDEF"):
            _,prev=graph.routes(source)
            for target in list("ABCDEF")+["exit"]:
                if source==target:continue
                through=[n for n,_ in graph.path(prev,source,target)][:-1]
                self.assertFalse(set(through)&set("ABCDEF"))
        graph.adj={n:[(b,e) for b,e in links if graph.edges[e]["kind"]!="shortcut"] for n,links in graph.adj.items()}
        loop,_=graph.routes(west)
        self.assertLess(short[east],loop[east])

    def test_deadline_during_admission_releases_reserved_capacity(self):
        config=copy.deepcopy(CONFIG);config["daily_visitors"]=30
        config["arrivals"].update(intensity="empirical_minutes",minute_weights=[1]+[0]*479,source="테스트 집중 입장")
        sim=Simulation(MAP,config)
        victim=None
        for _ in range(600):
            sim.advance_to(sim.now+1)
            victim=next((a for a in sim.active.values() if a.admitted_zone and a.edge),None)
            if victim:break
        self.assertIsNotNone(victim)
        victim_id=victim.id
        sim._deadline(victim)
        sim.advance_to(sim.horizon)
        self.assertEqual(sim.exited,30)
        self.assertEqual(sum(sim.occupancy.values()),0)
        record=next(v for v in sim.completed if v["id"]==victim_id)
        self.assertEqual(record["visits"],[])

    def test_full_day_conservation_and_capacity(self):
        sim=Simulation(MAP,CONFIG)
        self.assertEqual(len(sim.active),0)
        for t in range(int(sim.now)+600,int(sim.horizon)+1,600):
            sim.advance_to(t)
            s=sim.snapshot();m=s["metrics"]
            self.assertEqual(m["pending"]+m["inside"]+m["exited"],CONFIG["daily_visitors"])
            self.assertEqual(m["entered"],m["inside"]+m["exited"])
            self.assertTrue(all(0<=z["inside"]<=z["capacity"] for z in s["zones"]))
            self.assertTrue(all(v>=0 for v in sim.edge_load.values()))
        self.assertTrue(sim.snapshot()["done"])
        self.assertEqual(sim.exited,CONFIG["daily_visitors"])
        self.assertFalse(sim.active)
        self.assertTrue(all(v["exited_at"]>v["entered_at"] for v in sim.completed))
        self.assertEqual(sum(r["count"] for r in sim.report()["arrival_minutes"]),CONFIG["daily_visitors"])

    def test_timestep_does_not_change_results(self):
        config=copy.deepcopy(CONFIG);config["daily_visitors"]=60
        a,b=Simulation(MAP,config),Simulation(MAP,config)
        a.advance_to(a.horizon)
        while b.now<b.horizon:b.advance_to(min(b.horizon,b.now+137))
        self.assertEqual(a.report(),b.report())

    def test_empty_day(self):
        config=copy.deepcopy(CONFIG);config["daily_visitors"]=0
        sim=Simulation(MAP,config)
        self.assertTrue(sim.snapshot()["done"])

    def test_queues_clear_at_exit(self):
        config=copy.deepcopy(CONFIG);config["daily_visitors"]=180
        config["stay_minutes"]=[30,30]
        weights=[0]*480;weights[0]=1
        config["arrivals"].update(intensity="empirical_minutes",minute_weights=weights,source="테스트 합성 집중 유입")
        tiny=copy.deepcopy(MAP)
        for n in tiny["nodes"]:
            if "capacity" in n:n["capacity"]=1
        sim=Simulation(tiny,config)
        sim.advance_to(sim.now+1200)
        self.assertGreater(sim.snapshot()["metrics"]["queueing"],0)
        for a in sim.active.values():
            if a.state=="queueing":
                self.assertEqual(sim.graph.nodes[a.node]["kind"],"queue")
                self.assertIsNone(a.admitted_zone)
        sim.advance_to(sim.horizon)
        self.assertTrue(sim.snapshot()["done"])
        self.assertEqual(sum(sim.occupancy.values()),0)
        self.assertEqual(sum(sim.edge_load.values()),0)

if __name__=="__main__":unittest.main()
